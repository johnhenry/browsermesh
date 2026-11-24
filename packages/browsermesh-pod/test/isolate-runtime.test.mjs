import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  POD_HOST_ERROR,
  POD_HOST_EVENT_KIND,
  RUNTIME_BOUNDARY,
  createRuntimeLaneDriver,
} from '../src/index.mjs'
import {
  ISOLATED_VM_UNAVAILABLE,
  createIsolatedVmRuntime,
  isolatedVmAvailability,
} from '../src/node-runtimes.mjs'
import { driverConformance } from './helpers/driver-conformance.mjs'

const FIXTURES = path.join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'runtime-modules')
const MODULES = {
  probe: path.join(FIXTURES, 'isolate-probe.mjs'),
  imports: path.join(FIXTURES, 'isolate-imports.mjs'),
  'load-loop': path.join(FIXTURES, 'isolate-load-loop.mjs'),
  'no-handle': path.join(FIXTURES, 'isolate-no-handle.mjs'),
  broken: path.join(FIXTURES, 'broken.mjs'),
}
const SPEC = { name: 'pod', lane: 'isolate', run: { kind: 'module', ref: 'probe' } }

describe('isolate runtime: availability', () => {
  it('an unavailable addon is reported clearly, with a code, instead of failing later', () => {
    const load = () => { throw new Error('no binary for this platform') }
    assert.deepEqual(isolatedVmAvailability({ load }), {
      available: false,
      reason: "'isolated-vm' could not be loaded: no binary for this platform",
    })
    assert.throws(
      () => createIsolatedVmRuntime({ load }),
      (err) => err.code === ISOLATED_VM_UNAVAILABLE && /unavailable.*no binary for this platform/.test(err.message),
    )
    assert.throws(() => createIsolatedVmRuntime({ load: () => ({}) }), (err) => err.code === ISOLATED_VM_UNAVAILABLE)
  })
})

const availability = isolatedVmAvailability()

describe('isolate runtime (isolated-vm)', { skip: availability.available ? false : `isolated-vm is not available here: ${availability.reason}` }, () => {
  const made = []
  /** A driver over a fresh isolate runtime. */
  function makeDriver(runtimeOpts = {}, driverOpts = {}) {
    const driver = createRuntimeLaneDriver({ runtime: createIsolatedVmRuntime(runtimeOpts), modules: MODULES, ...driverOpts })
    made.push(driver)
    return driver
  }
  after(async () => {
    for (const d of made) for (const s of await d.list()) if (s.state !== 'gone') await d.drain(s.name).catch(() => {})
  })

  driverConformance('isolated-vm lane driver', () => ({ driver: makeDriver() }), { spec: SPEC })

  describe('what it advertises', () => {
    it('is the isolate lane at the language boundary', () => {
      const runtime = createIsolatedVmRuntime()
      assert.equal(runtime.kind, 'isolated-vm')
      assert.equal(runtime.lane, 'isolate')
      assert.equal(runtime.boundary, RUNTIME_BOUNDARY.LANGUAGE)
      const driver = createRuntimeLaneDriver({ runtime, modules: MODULES })
      assert.deepEqual(driver.capabilities().boundary, 'language')
      assert.equal(driver.capabilities().runtime, 'isolated-vm')
      assert.ok(!driver.capabilities().verbs.includes('exec'))
    })
  })

  describe('running a module', () => {
    let driver
    before(() => { driver = makeDriver() })
    const call = (name, payload) => driver.send(name, { payload })

    it('loads the catalog module, answers send, passes env and input as data, and captures log lines', async () => {
      const events = []
      driver.onEvent((e) => events.push(e))
      await driver.spawn({ ...SPEC, name: 'run-a', env: { GREETING: 'hello' }, run: { kind: 'module', ref: 'probe', input: { seed: [1, 2] } } })
      assert.deepEqual((await call('run-a', { probe: 'echo', arg: 1 })).reply, { echoed: { probe: 'echo', arg: 1 } })
      const ctx = (await call('run-a', { probe: 'ctx' })).reply
      assert.deepEqual(ctx, { name: 'run-a', env: { GREETING: 'hello' }, input: { seed: [1, 2] }, keys: ['env', 'input', 'log', 'name'], frozen: true })
      await call('run-a', { probe: 'log', arg: 'a line from the pod' })
      await new Promise((resolve) => setImmediate(resolve))
      const lines = events.filter((e) => e.kind === POD_HOST_EVENT_KIND.LOG && e.data.name === 'run-a').map((e) => e.data.chunk)
      assert.deepEqual(lines, ['started run-a', 'a line from the pod'])
    })

    it('an error thrown by handle() reaches the sender and the pod keeps running', async () => {
      await driver.spawn({ ...SPEC, name: 'run-b' })
      await assert.rejects(
        () => call('run-b', { probe: 'throw-error', arg: 'nope' }),
        (err) => err.code === POD_HOST_ERROR.EINVAL && /unknown probe 'nope'/.test(err.message),
      )
      assert.equal((await call('run-b', { probe: 'echo' })).delivered, true)
    })

    it('a thrown value with a hostile getter is described safely, not executed on the host', async () => {
      await driver.spawn({ ...SPEC, name: 'run-c' })
      await assert.rejects(() => call('run-c', { probe: 'throw-weird' }), (err) => err.code === POD_HOST_ERROR.EINVAL)
      assert.equal((await call('run-c', { probe: 'echo' })).delivered, true)
    })

    it('a module that does not load, has no handle(), or imports anything is refused at spawn', async () => {
      for (const ref of ['broken', 'no-handle', 'imports']) {
        await assert.rejects(
          () => driver.spawn({ ...SPEC, name: `bad-${ref}`, run: { kind: 'module', ref } }),
          (err) => err.code === POD_HOST_ERROR.EINVAL && /failed to start/.test(err.message),
          ref,
        )
        assert.equal((await driver.status(`bad-${ref}`)).state, 'gone')
      }
      await assert.rejects(
        () => driver.spawn({ ...SPEC, name: 'bad-imports-2', run: { kind: 'module', ref: 'imports' } }),
        /may not import anything/,
      )
    })

    it('a module whose top level never finishes is stopped by the load limit', async () => {
      const quick = makeDriver({ startTimeoutMs: 300 })
      await assert.rejects(
        () => quick.spawn({ ...SPEC, name: 'loop', run: { kind: 'module', ref: 'load-loop' } }),
        /timed out while starting/,
      )
      assert.equal((await quick.status('loop')).state, 'gone')
    })

    it('a request or reply larger than the host allows is refused and the pod keeps running', async () => {
      const small = makeDriver({ maxReplyBytes: 1000, maxRequestBytes: 1000 })
      await small.spawn({ ...SPEC, name: 'big' })
      await assert.rejects(() => small.send('big', { payload: { probe: 'huge-reply', arg: 5000 } }), /larger than this host allows/)
      await assert.rejects(() => small.send('big', { payload: { probe: 'echo', arg: 'x'.repeat(2000) } }), /request is larger than 1000 bytes/)
      assert.equal((await small.send('big', { payload: { probe: 'echo' } })).delivered, true)
    })

    it('a reply that cannot be JSON is an error, not a crash', async () => {
      await driver.spawn({ ...SPEC, name: 'run-d' })
      await assert.rejects(() => call('run-d', { probe: 'unserialisable-reply' }), (err) => err.code === POD_HOST_ERROR.EINVAL)
      assert.equal((await call('run-d', { probe: 'echo' })).delivered, true)
    })

    it('a pod that tampers with its own JSON cannot return anything but a string to the host', async () => {
      await driver.spawn({ ...SPEC, name: 'run-e' })
      await assert.rejects(() => call('run-e', { probe: 'tamper-reply' }), /not a reply/)
      await assert.rejects(() => call('run-e', { probe: 'echo' }), (err) => err.code === POD_HOST_ERROR.EINVAL)
    })

    it('caps the log a pod can write', async () => {
      const capped = makeDriver({ maxLogBytes: 64 })
      const lines = []
      capped.onEvent((e) => { if (e.kind === POD_HOST_EVENT_KIND.LOG) lines.push(e.data.chunk) })
      await capped.spawn({ ...SPEC, name: 'chatty' })
      for (let i = 0; i < 20; i += 1) await capped.send('chatty', { payload: { probe: 'log', arg: 'y'.repeat(40) } })
      await new Promise((resolve) => setImmediate(resolve))
      assert.ok(lines.length < 6, `${lines.length} lines`)
      assert.equal(lines.filter((l) => /log truncated/.test(l)).length, 1)
    })
  })

  describe('no ambient authority', () => {
    let driver
    before(async () => {
      driver = makeDriver()
      await driver.spawn({ ...SPEC, name: 'bare' })
    })
    const call = (payload) => driver.send('bare', { payload })

    it('has none of the host globals, no timers, no WebAssembly', async () => {
      assert.deepEqual((await call({ probe: 'forbidden-globals' })).reply, [])
    })

    it('has no dynamic import', async () => {
      const { reply } = await call({ probe: 'dynamic-import' })
      assert.match(reply, /^refused/)
    })

    it('WebAssembly memory, which would not count against the heap limit, does not exist', async () => {
      assert.equal((await call({ probe: 'wasm-memory' })).reply, 'no WebAssembly')
    })
  })

  describe('escape attempts are contained', () => {
    let driver
    let events
    before(async () => {
      driver = makeDriver()
      events = []
      driver.onEvent((e) => events.push(e))
      await driver.spawn({ ...SPEC, name: 'esc', env: { K: 'v' } })
    })
    const call = (payload) => driver.send('esc', { payload })

    it('constructor.constructor from any value it holds yields the isolate\'s own Function, which has nothing', async () => {
      const { reply } = await call({ probe: 'function-constructor' })
      assert.deepEqual(reply, { fromLog: 'undefined/undefined/undefined', fromObject: 'undefined', fromEnv: 'undefined' })
    })

    it('a prototype and property walk from everything the pod was handed finds no host object', async () => {
      const { reply } = await call({ probe: 'prototype-walk' })
      assert.equal(reply.reached, true)
      assert.deepEqual(reply.hostish, [])
      assert.equal(reply.leaks, 0)
    })

    it('a thenable given to the host callback is stringified, never invoked', async () => {
      const { reply } = await call({ probe: 'thenable-log' })
      assert.deepEqual(reply, { thenCalled: false })
    })

    it('the host callback returns nothing the pod could await or chain on', async () => {
      const { reply } = await call({ probe: 'log-result' })
      assert.deepEqual(reply, { type: 'undefined', isThenable: false })
    })

    it('a host log handler that sends back into the pod from inside the log event is served, outside the isolate\'s callback', async () => {
      const d = makeDriver()
      const nested = []
      d.onEvent((e) => {
        if (e.kind !== POD_HOST_EVENT_KIND.LOG || e.data.chunk !== 'reenter') return
        nested.push(d.send('re', { payload: { probe: 'echo', arg: 'nested' } }).then((r) => r.reply))
      })
      await d.spawn({ ...SPEC, name: 're' })
      assert.equal((await d.send('re', { payload: { probe: 'log-reenter' } })).reply, 'logged')
      assert.deepEqual(await Promise.all(nested), [{ echoed: { probe: 'echo', arg: 'nested' } }])
    })

    it('a host log handler that drains the pod from inside the log event ends it cleanly', async () => {
      const d = makeDriver()
      const drains = []
      d.onEvent((e) => {
        if (e.kind !== POD_HOST_EVENT_KIND.LOG || e.data.chunk !== 'reenter') return
        drains.push(d.drain('re2').then((s) => s.state))
      })
      await d.spawn({ ...SPEC, name: 're2' })
      // The request in flight is failed with a clear error rather than left hanging.
      await assert.rejects(() => d.send('re2', { payload: { probe: 'log-reenter' } }), /terminated/)
      assert.deepEqual(await Promise.all(drains), ['gone'])
    })

    it('a handler that throws inside the host\'s log subscriber does not reach the pod', async () => {
      const d = makeDriver()
      d.onEvent(() => { throw new Error('subscriber failed') })
      await d.spawn({ ...SPEC, name: 'thrower' })
      assert.equal((await d.send('thrower', { payload: { probe: 'log', arg: 'hi' } })).reply, 'logged')
    })

    it('exhausting memory disposes only that pod, reports oom, and the host and other pods carry on', async () => {
      const d = makeDriver()
      const exits = []
      d.onEvent((e) => { if (e.kind === POD_HOST_EVENT_KIND.LIFECYCLE && e.data.to === 'gone') exits.push(e.data.reason) })
      await d.spawn({ ...SPEC, name: 'victim', limits: { memMib: 16 } })
      await d.spawn({ ...SPEC, name: 'bystander' })
      await assert.rejects(() => d.send('victim', { payload: { probe: 'alloc' } }), (err) => /memory limit/.test(err.message))
      assert.equal((await d.status('victim')).state, 'gone')
      assert.deepEqual(exits, ['oom'])
      assert.equal((await d.send('bystander', { payload: { probe: 'echo' } })).delivered, true)
    })

    it('the heap limit is the pod\'s own limits.memMib: the same allocation is fine under a larger limit', async () => {
      const d = makeDriver()
      await d.spawn({ ...SPEC, name: 'small', limits: { memMib: 16 } })
      await d.spawn({ ...SPEC, name: 'large', limits: { memMib: 512 } })
      await assert.rejects(() => d.send('small', { payload: { probe: 'alloc-mib', arg: 120 } }), /memory limit/)
      assert.equal((await d.send('large', { payload: { probe: 'alloc-mib', arg: 120 } })).reply, 120)
    })

    it('the exit event names the limit that was breached', async () => {
      const d = makeDriver()
      const exits = []
      d.onEvent((e) => { if (e.kind === POD_HOST_EVENT_KIND.EXIT) exits.push(e.data) })
      await d.spawn({ ...SPEC, name: 'victim2', limits: { memMib: 16 } })
      await assert.rejects(() => d.send('victim2', { payload: { probe: 'alloc' } }))
      await d.spawn({ ...SPEC, name: 'victim3', limits: { timeoutMs: 200 } })
      await assert.rejects(() => d.send('victim3', { payload: { probe: 'spin' } }))
      assert.deepEqual(exits.map((x) => [x.name, x.cause]), [['victim2', 'oom'], ['victim3', 'timeout']])
    })

    it('a tight loop, in the first segment, after an await, and in the microtask queue, is stopped by the time limit', async () => {
      for (const probe of ['spin', 'spin-after-await', 'spin-microtasks', 'atomics-wait', 'hang']) {
        const d = makeDriver()
        const reasons = []
        d.onEvent((e) => { if (e.kind === POD_HOST_EVENT_KIND.LIFECYCLE && e.data.to === 'gone') reasons.push(e.data.reason) })
        await d.spawn({ ...SPEC, name: 'looper', limits: { timeoutMs: 300 } })
        const started = Date.now()
        await assert.rejects(
          () => d.send('looper', { payload: { probe } }),
          (err) => err.code === POD_HOST_ERROR.ETIMEDOUT,
          probe,
        )
        assert.ok(Date.now() - started < 5000, `${probe} took ${Date.now() - started} ms`)
        assert.equal((await d.status('looper')).state, 'gone', probe)
        assert.deepEqual(reasons, ['timeout'], probe)
      }
    })

    it('a pod that is gone cannot be sent to', async () => {
      const d = makeDriver()
      await d.spawn({ ...SPEC, name: 'dead', limits: { timeoutMs: 200 } })
      await assert.rejects(() => d.send('dead', { payload: { probe: 'spin' } }))
      await assert.rejects(() => d.send('dead', { payload: { probe: 'echo' } }), (err) => err.code === POD_HOST_ERROR.ENOENT || err.code === POD_HOST_ERROR.EBUSY)
    })

    it('limits the requests a pod may have outstanding', async () => {
      const d = makeDriver({ maxInFlight: 2 })
      await d.spawn({ ...SPEC, name: 'busy', limits: { timeoutMs: 400 } })
      const results = await Promise.allSettled([1, 2, 3, 4].map(() => d.send('busy', { payload: { probe: 'hang' } })))
      assert.ok(results.some((r) => r.status === 'rejected' && /outstanding/.test(r.reason.message)))
    })
  })

  describe('lifecycle', () => {
    it('drain disposes the isolate and reports drained, never an unexpected exit', async () => {
      const d = makeDriver()
      const exits = []
      d.onEvent((e) => { if (e.kind === POD_HOST_EVENT_KIND.EXIT) exits.push(e.data) })
      await d.spawn({ ...SPEC, name: 'drainme' })
      await d.drain('drainme')
      assert.deepEqual(exits.map((x) => [x.reason, x.restartable]), [['drained', false]])
    })

    it('a pod with no module path is refused', async () => {
      const runtime = createIsolatedVmRuntime()
      await assert.rejects(() => runtime.start({ name: 'x', modulePath: 'relative.mjs', env: {}, limits: {}, onLog() {}, onExit() {} }), /absolute/)
    })
  })
})
