import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  POD_HOST_ERROR,
  POD_HOST_EVENT_KIND,
  createRuntimeLaneDriver,
} from '../src/index.mjs'
import {
  createPermissionProcessRuntime,
  createWorkerThreadsRuntime,
} from '../src/node-runtimes.mjs'
import { driverConformance } from './helpers/driver-conformance.mjs'

const FIXTURES = path.join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'runtime-modules')
const MODULES = {
  probe: path.join(FIXTURES, 'probe.mjs'),
  broken: path.join(FIXTURES, 'broken.mjs'),
}
const SPEC = { name: 'pod', lane: 'node', run: { kind: 'module', ref: 'probe' } }

const RUNTIMES = {
  'worker_threads': () => createWorkerThreadsRuntime(),
  'node-permission-process': () => createPermissionProcessRuntime(),
}

for (const [label, makeRuntime] of Object.entries(RUNTIMES)) {
  const makeDriver = (driverOpts = {}) => {
    const drivers = []
    const driver = createRuntimeLaneDriver({ runtime: makeRuntime(), modules: MODULES, ...driverOpts })
    drivers.push(driver)
    return {
      driver,
      // Whatever a test left running is stopped.
      cleanup: async () => {
        for (const d of drivers) {
          for (const s of await d.list()) if (s.state !== 'gone') await d.drain(s.name).catch(() => {})
        }
      },
    }
  }

  driverConformance(`${label} lane driver`, () => makeDriver(), { spec: SPEC })

  describe(`${label}: running a module`, () => {
    let made
    before(() => { made = makeDriver() })
    after(async () => { await made.cleanup() })

    it('loads the catalog module, answers send, and captures its log line', async () => {
      const events = []
      made.driver.onEvent((e) => events.push(e))
      await made.driver.spawn({ ...SPEC, name: 'run-a' })
      const result = await made.driver.send('run-a', { payload: { probe: 'echo', arg: 1 } })
      assert.deepEqual(result.reply, { echoed: { probe: 'echo', arg: 1 } })
      const log = events.find((e) => e.kind === POD_HOST_EVENT_KIND.LOG)
      assert.match(log.data.chunk, /started run-a/)
    })

    it('a module that throws on load is EINVAL and leaves a tombstone', async () => {
      await assert.rejects(
        () => made.driver.spawn({ ...SPEC, name: 'run-b', run: { kind: 'module', ref: 'broken' } }),
        (err) => err.code === POD_HOST_ERROR.EINVAL && /cannot load/.test(err.message),
      )
      assert.equal((await made.driver.status('run-b')).state, 'gone')
    })

    it('an error thrown by handle() is reported to the sender and the pod keeps running', async () => {
      await made.driver.spawn({ ...SPEC, name: 'run-c' })
      await assert.rejects(
        () => made.driver.send('run-c', { payload: { probe: 'nope' } }),
        (err) => err.code === POD_HOST_ERROR.EINVAL && /unknown probe/.test(err.message),
      )
      assert.equal((await made.driver.send('run-c', { payload: { probe: 'echo' } })).delivered, true)
    })

    it('a reply that never comes is ETIMEDOUT, not a hang', async () => {
      await made.driver.spawn({ ...SPEC, name: 'run-d', limits: { timeoutMs: 100 } })
      await assert.rejects(
        () => made.driver.send('run-d', { payload: { probe: 'hang' } }),
        (err) => err.code === POD_HOST_ERROR.ETIMEDOUT,
      )
    })

    it('a pod that crashes becomes gone with a restartable crash event', async () => {
      const events = []
      made.driver.onEvent((e) => events.push(e))
      await made.driver.spawn({ ...SPEC, name: 'run-e' })
      await made.driver.send('run-e', { payload: { probe: 'crash' } })
      await waitFor(async () => (await made.driver.status('run-e')).state === 'gone')
      const exit = events.find((e) => e.kind === POD_HOST_EVENT_KIND.EXIT && e.data.name === 'run-e')
      assert.equal(exit.data.reason, 'crashed')
      assert.equal(exit.data.restartable, true)
    })

    it('a pod that exceeds its memory limit is stopped and reported', async () => {
      const events = []
      made.driver.onEvent((e) => events.push(e))
      await made.driver.spawn({ ...SPEC, name: 'run-f', limits: { memMib: 32, timeoutMs: 20_000 } })
      await made.driver.send('run-f', { payload: { probe: 'alloc' } }).catch(() => {})
      await waitFor(async () => (await made.driver.status('run-f')).state === 'gone')
      assert.ok(events.some((e) => e.kind === POD_HOST_EVENT_KIND.EXIT && e.data.name === 'run-f'))
    })
  })

  describe(`${label}: environment`, () => {
    let made
    before(() => { made = makeDriver() })
    after(async () => { await made.cleanup() })

    it('holds only what the podspec named, none of the host environment', async () => {
      process.env.HOST_SECRET_FOR_TEST = 'do-not-leak'
      try {
        await made.driver.spawn({ ...SPEC, name: 'env-a', env: { GREETING: 'hi' } })
        const { reply } = await made.driver.send('env-a', { payload: { probe: 'env' } })
        assert.deepEqual(reply.ctxEnv, { GREETING: 'hi' })
        assert.ok(!reply.processEnvKeys.includes('HOST_SECRET_FOR_TEST'))
        assert.ok(!reply.processEnvKeys.includes('HOME'))
        assert.ok(!reply.processEnvKeys.includes('PATH'))
        assert.ok(reply.processEnvKeys.includes('GREETING'))
      } finally {
        delete process.env.HOST_SECRET_FOR_TEST
      }
    })
  })
}

// ---------------------------------------------------------------------------
// What each runtime does and does not stop. These are the claims the
// documentation makes; a test here that flips means the documentation is wrong.
// ---------------------------------------------------------------------------

describe('what a permission-model child process cannot reach', () => {
  let dir
  let secretPath
  let listener
  let connections
  let driver
  before(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pod-perm-')))
    secretPath = path.join(dir, 'host-secret.txt')
    fs.writeFileSync(secretPath, 'host secret')
    connections = 0
    listener = net.createServer((socket) => { connections += 1; socket.destroy() })
    await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve))
    driver = createRuntimeLaneDriver({ runtime: createPermissionProcessRuntime(), modules: MODULES })
    await driver.spawn({ ...SPEC, name: 'perm' })
  })
  after(async () => {
    await driver.drain('perm')
    await new Promise((resolve) => listener.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const probe = async (probeName, arg) => (await driver.send('perm', { payload: { probe: probeName, arg } })).reply

  it('cannot read a file of the host', async () => {
    assert.deepEqual(await probe('fs-read', secretPath), { ok: false, code: 'ERR_ACCESS_DENIED' })
    assert.deepEqual(await probe('fs-read', '/etc/hosts'), { ok: false, code: 'ERR_ACCESS_DENIED' })
  })

  it('cannot write anywhere', async () => {
    const target = path.join(dir, 'written.txt')
    assert.deepEqual(await probe('fs-write', target), { ok: false, code: 'ERR_ACCESS_DENIED' })
    assert.equal(fs.existsSync(target), false)
  })

  it('cannot open a network connection (the listener never sees one)', async () => {
    const result = await probe('net', listener.address().port)
    assert.equal(result.ok, false)
    assert.equal(result.code, 'ERR_ACCESS_DENIED')
    assert.equal(connections, 0)
  })

  it('cannot start a process or a worker', async () => {
    assert.deepEqual(await probe('spawn'), { ok: false, code: 'ERR_ACCESS_DENIED' })
    assert.deepEqual(await probe('worker'), { ok: false, code: 'ERR_ACCESS_DENIED' })
  })
})

describe('NOT DEFENDED: what a worker_threads pod can reach (documented gaps)', () => {
  let dir
  let secretPath
  let listener
  let connections
  let driver
  before(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pod-worker-')))
    secretPath = path.join(dir, 'host-secret.txt')
    fs.writeFileSync(secretPath, 'host secret')
    connections = 0
    listener = net.createServer((socket) => { connections += 1; socket.destroy() })
    await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve))
    driver = createRuntimeLaneDriver({ runtime: createWorkerThreadsRuntime(), modules: MODULES })
    await driver.spawn({ ...SPEC, name: 'worker' })
  })
  after(async () => {
    await driver.drain('worker')
    await new Promise((resolve) => listener.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const probe = async (probeName, arg) => (await driver.send('worker', { payload: { probe: probeName, arg } })).reply

  it('CAN read a file of the host', async () => {
    assert.deepEqual(await probe('fs-read', secretPath), { ok: true, value: 'host secret' })
  })

  it('CAN write a file on the host', async () => {
    const target = path.join(dir, 'written.txt')
    assert.deepEqual(await probe('fs-write', target), { ok: true, value: 'wrote' })
    assert.equal(fs.readFileSync(target, 'utf8'), 'written by the pod')
  })

  it('CAN open a network connection from the host', async () => {
    assert.deepEqual(await probe('net', listener.address().port), { ok: true, value: 'connected' })
    await waitFor(async () => connections === 1)
  })

  it('CAN start a process', async () => {
    assert.deepEqual(await probe('spawn'), { ok: true, value: '2' })
  })
})

/**
 * Poll a condition without a fixed delay budget: the test runner's own
 * timeout is the bound. Used only to wait for an event the runtime reports.
 * @param {() => Promise<boolean>} condition
 */
async function waitFor(condition) {
  for (;;) {
    if (await condition()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
}
