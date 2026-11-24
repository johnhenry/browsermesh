import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  InMemoryPodHostDriver,
  POD_HOST_ERROR,
  POD_HOST_EVENT_KIND,
  RUNTIME_BOUNDARY,
  createRuntimeLaneDriver,
} from '../src/index.mjs'
import { driverConformance } from './helpers/driver-conformance.mjs'

/**
 * A runtime with no real execution: records what the driver asked for, and
 * lets a test make the "pod" reply, hang, fail to start or exit on its own.
 */
function fakeRuntime(overrides = {}) {
  const runtime = {
    kind: 'fake',
    lane: 'node',
    boundary: RUNTIME_BOUNDARY.NONE,
    started: [],
    terminated: [],
    exits: new Map(),
    behaviour: { reply: (payload) => ({ echoed: payload }), startError: null, hang: false },
    async start(opts) {
      runtime.started.push(opts)
      runtime.exits.set(opts.name, opts.onExit)
      if (runtime.behaviour.startError) throw new Error(runtime.behaviour.startError)
      return {
        request: async (payload, { timeoutMs }) => {
          if (runtime.behaviour.hang) {
            const err = new Error(`no reply within ${timeoutMs}`)
            err.code = 'ETIMEDOUT'
            throw err
          }
          return runtime.behaviour.reply(payload)
        },
        terminate: async () => { runtime.terminated.push(opts.name) },
      }
    },
    ...overrides,
  }
  return runtime
}

const SPEC = { name: 'p', lane: 'node', run: { kind: 'module', ref: 'echo' } }
const MODULES = { echo: '/srv/modules/echo.mjs' }

function make(runtimeOverrides, driverOpts = {}) {
  const runtime = fakeRuntime(runtimeOverrides)
  const driver = createRuntimeLaneDriver({ runtime, modules: MODULES, ...driverOpts })
  return { runtime, driver }
}

// The same checks the in-memory reference driver passes.
driverConformance('runtime lane driver (fake runtime)', () => ({ driver: make().driver }), { spec: SPEC })
driverConformance('InMemoryPodHostDriver (node lane)', () => ({ driver: new InMemoryPodHostDriver({ lane: 'node' }) }), { spec: SPEC, checksLane: false })

describe('createRuntimeLaneDriver: construction', () => {
  it('needs a runtime with a lane and a known boundary', () => {
    assert.throws(() => createRuntimeLaneDriver({}), /runtime with start/)
    assert.throws(() => createRuntimeLaneDriver({ runtime: fakeRuntime({ lane: 'cloud' }) }), /lane/)
    assert.throws(() => createRuntimeLaneDriver({ runtime: fakeRuntime({ boundary: 'strong' }) }), /boundary/)
  })

  it('refuses to advertise the isolate lane without a language or hardware boundary', () => {
    for (const boundary of [RUNTIME_BOUNDARY.NONE, RUNTIME_BOUNDARY.PROCESS]) {
      assert.throws(
        () => createRuntimeLaneDriver({ runtime: fakeRuntime({ lane: 'isolate', boundary }) }),
        /cannot be advertised as the isolate lane/,
      )
    }
    for (const boundary of [RUNTIME_BOUNDARY.LANGUAGE, RUNTIME_BOUNDARY.HARDWARE]) {
      assert.doesNotThrow(() => createRuntimeLaneDriver({ runtime: fakeRuntime({ lane: 'isolate', boundary }) }))
    }
  })

  it('advertises its boundary and serves spawn, status, send, drain and list', () => {
    const { driver } = make()
    assert.deepEqual(driver.capabilities(), {
      verbs: ['spawn', 'status', 'send', 'drain', 'list'],
      boundary: 'none',
      runtime: 'fake',
    })
  })
})

describe('createRuntimeLaneDriver: what may run', () => {
  it('runs only modules from the host catalog, never a path from the requester', async () => {
    const { driver, runtime } = make()
    for (const ref of ['/etc/passwd', '../escape.mjs', 'file:///etc/passwd', 'constructor', '__proto__', 'toString']) {
      await assert.rejects(
        () => driver.spawn({ ...SPEC, name: 'x', run: { kind: 'module', ref } }),
        (err) => err.code === POD_HOST_ERROR.ENOENT,
        ref,
      )
    }
    assert.deepEqual(runtime.started, [])
    await driver.spawn(SPEC)
    assert.equal(runtime.started[0].modulePath, '/srv/modules/echo.mjs')
  })

  it('passes a catalog entry\'s extra read paths to the runtime', async () => {
    const { driver, runtime } = make({}, { modules: { echo: { path: '/srv/m/echo.mjs', readPaths: ['/srv/m/lib'] } } })
    await driver.spawn(SPEC)
    assert.deepEqual(runtime.started[0].readPaths, ['/srv/m/lib'])
  })

  it('refuses run kinds this host cannot run', async () => {
    const { driver } = make()
    await assert.rejects(
      () => driver.spawn({ ...SPEC, run: { kind: 'command', ref: 'echo' } }),
      (err) => err.code === POD_HOST_ERROR.EINVAL && /module or skill only/.test(err.message),
    )
  })

  it('gives the pod only the environment its podspec names', async () => {
    const { driver, runtime } = make()
    process.env.HOST_SECRET_FOR_TEST = 'do-not-leak'
    try {
      await driver.spawn({ ...SPEC, env: { GREETING: 'hi' } })
    } finally {
      delete process.env.HOST_SECRET_FOR_TEST
    }
    assert.deepEqual(runtime.started[0].env, { GREETING: 'hi' })
  })

  it('refuses environment variables that change how the runtime loads code or applies its limits', async () => {
    const { driver, runtime } = make()
    for (const name of ['NODE_OPTIONS', 'node_options', 'NODE_PATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'UV_THREADPOOL_SIZE', 'OPENSSL_CONF']) {
      await assert.rejects(
        () => driver.spawn({ ...SPEC, env: { [name]: '1' } }),
        (err) => err.code === POD_HOST_ERROR.EINVAL,
        name,
      )
    }
    assert.deepEqual(runtime.started, [])
  })
})

describe('createRuntimeLaneDriver: admission limits', () => {
  it('refuses a pod over maxPods with EBUSY, counting only live pods', async () => {
    const { driver } = make({}, { maxPods: 1 })
    await driver.spawn(SPEC)
    await assert.rejects(() => driver.spawn({ ...SPEC, name: 'q' }), (err) => err.code === POD_HOST_ERROR.EBUSY)
    await driver.drain('p')
    await driver.spawn({ ...SPEC, name: 'q' })
  })

  it('applies the default memory limit and refuses one above the host maximum', async () => {
    const { driver, runtime } = make({}, { maxMemMib: 256, defaultMemMib: 64 })
    await driver.spawn(SPEC)
    assert.equal(runtime.started[0].limits.memMib, 64)
    await driver.spawn({ ...SPEC, name: 'big', limits: { memMib: 256 } })
    assert.equal(runtime.started[1].limits.memMib, 256)
    await assert.rejects(
      () => driver.spawn({ ...SPEC, name: 'huge', limits: { memMib: 257 } }),
      (err) => err.code === POD_HOST_ERROR.EINVAL && /maximum/.test(err.message),
    )
  })
})

describe('createRuntimeLaneDriver: lifecycle', () => {
  it('a runtime that cannot start leaves a gone tombstone and EINVAL', async () => {
    const { driver, runtime } = make()
    runtime.behaviour.startError = 'cannot import module'
    await assert.rejects(() => driver.spawn(SPEC), (err) => err.code === POD_HOST_ERROR.EINVAL && /cannot import module/.test(err.message))
    assert.equal((await driver.status('p')).state, 'gone')
  })

  it('drain terminates the runtime exactly once', async () => {
    const { driver, runtime } = make()
    await driver.spawn(SPEC)
    await driver.drain('p')
    await driver.drain('p')
    assert.deepEqual(runtime.terminated, ['p'])
  })

  it('a pod that dies on its own becomes gone with a restartable crash exit', async () => {
    const { driver, runtime } = make()
    const events = []
    driver.onEvent((e) => events.push(e))
    await driver.spawn(SPEC)
    runtime.exits.get('p')({ code: 1, reason: 'oom' })
    assert.equal((await driver.status('p')).state, 'gone')
    const exit = events.find((e) => e.kind === POD_HOST_EVENT_KIND.EXIT)
    assert.equal(exit.data.reason, 'crashed')
    assert.equal(exit.data.restartable, true)
    assert.equal(exit.data.cause, 'oom')
    await assert.rejects(() => driver.send('p', { payload: 1 }), (err) => err.code === POD_HOST_ERROR.ENOENT)
  })

  it('an exit report after a drain is ignored', async () => {
    const { driver, runtime } = make()
    const events = []
    driver.onEvent((e) => events.push(e))
    await driver.spawn(SPEC)
    await driver.drain('p')
    runtime.exits.get('p')({ code: 0, reason: 'exited' })
    assert.equal(events.filter((e) => e.kind === POD_HOST_EVENT_KIND.EXIT).length, 1)
  })
})

describe('createRuntimeLaneDriver: send', () => {
  it('delivers the payload and returns the pod\'s reply', async () => {
    const { driver } = make()
    await driver.spawn(SPEC)
    assert.deepEqual(await driver.send('p', { to: 'x', payload: { n: 1 } }), {
      delivered: true,
      reply: { echoed: { to: 'x', payload: { n: 1 } } },
    })
  })

  it('reports a reply that never comes as ETIMEDOUT', async () => {
    const { driver, runtime } = make()
    await driver.spawn(SPEC)
    runtime.behaviour.hang = true
    await assert.rejects(() => driver.send('p', { payload: 1 }), (err) => err.code === POD_HOST_ERROR.ETIMEDOUT)
  })

  it('exec, snapshot and restore are ENOTSUP on the node lane and ELANE on the isolate lane', async () => {
    const node = make().driver
    await node.spawn(SPEC)
    await assert.rejects(() => node.exec('p', ['true']), (err) => err.code === POD_HOST_ERROR.ENOTSUP)
    const isolate = make({ lane: 'isolate', boundary: RUNTIME_BOUNDARY.LANGUAGE }).driver
    await isolate.spawn({ ...SPEC, lane: 'isolate' })
    await assert.rejects(() => isolate.exec('p', ['true']), (err) => err.code === POD_HOST_ERROR.ELANE)
    await assert.rejects(() => isolate.snapshot('p'), (err) => err.code === POD_HOST_ERROR.ELANE)
  })
})
