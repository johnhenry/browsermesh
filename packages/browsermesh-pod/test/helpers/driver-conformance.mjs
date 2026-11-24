/**
 * driver-conformance.mjs -- the checks every `PodHostDriver` must pass,
 * whichever lane it serves (issue #185). Import it from a test file and call
 * `driverConformance(name, makeDriver, { spec })`; the in-memory reference
 * driver, the runtime lane driver and the spikes' drivers all run it.
 *
 * `makeDriver()` returns `{ driver, cleanup? }`. `spec` is a podspec the
 * driver can spawn (any name; the suite renames it).
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'

import {
  POD_HOST_ERROR,
  POD_HOST_EVENT_KIND,
  POD_HOST_VERBS,
  POD_LIFECYCLE,
  laneSupports,
} from '../../src/index.mjs'

/**
 * @param {string} label
 * @param {() => Promise<{driver: object, cleanup?: () => Promise<void>}>|{driver: object, cleanup?: () => Promise<void>}} makeDriver
 * @param {{spec: object, checksLane?: boolean}} options
 */
export function driverConformance(label, makeDriver, { spec, checksLane = true }) {
  describe(`PodHostDriver conformance: ${label}`, () => {
    /** @type {Array<() => Promise<void>>} */
    const cleanups = []
    after(async () => { for (const fn of cleanups) await fn() })

    async function fresh() {
      const made = await makeDriver()
      if (made.cleanup) cleanups.push(made.cleanup)
      return made.driver
    }
    const named = (name) => ({ ...spec, name })

    it('has a lane, a capabilities() verb list inside the lane, and every verb as a function', async () => {
      const driver = await fresh()
      assert.equal(typeof driver.lane, 'string')
      const { verbs } = driver.capabilities()
      assert.ok(verbs.length > 0)
      for (const verb of verbs) {
        assert.ok(POD_HOST_VERBS.includes(verb), `unknown verb ${verb}`)
        assert.ok(laneSupports(driver.lane, verb), `${verb} is not a verb of lane ${driver.lane}`)
      }
      for (const verb of POD_HOST_VERBS) assert.equal(typeof driver[verb], 'function', `driver.${verb}`)
    })

    it('spawn answers a registered status carrying the pod name and lane', async () => {
      const driver = await fresh()
      const status = await driver.spawn(named('conf-a'))
      assert.equal(status.name, 'conf-a')
      assert.equal(status.lane, driver.lane)
      assert.equal(status.state, POD_LIFECYCLE.REGISTERED)
    })

    it('a second spawn of a live name is EEXIST', async () => {
      const driver = await fresh()
      await driver.spawn(named('conf-b'))
      await assert.rejects(() => driver.spawn(named('conf-b')), (err) => err.code === POD_HOST_ERROR.EEXIST)
    })

    it('an invalid podspec is EINVAL and creates nothing', async () => {
      const driver = await fresh()
      await assert.rejects(() => driver.spawn({ name: 'conf-c', run: { kind: 'nope' } }), (err) => err.code === POD_HOST_ERROR.EINVAL)
      assert.deepEqual(await driver.list(), [])
    })

    it('a podspec for another lane is ELANE', async (t) => {
      // `InMemoryPodHostDriver` is deliberately lenient about the spec's lane
      // (its callers rely on that), so it opts out; real lane drivers do not.
      if (!checksLane) return t.skip('driver does not check the podspec lane')
      const driver = await fresh()
      const other = driver.lane === 'microvm' ? 'isolate' : 'microvm'
      await assert.rejects(() => driver.spawn({ ...named('conf-d'), lane: other }), (err) => err.code === POD_HOST_ERROR.ELANE)
    })

    it('status and drain of an unknown pod are ENOENT', async () => {
      const driver = await fresh()
      await assert.rejects(() => driver.status('nobody'), (err) => err.code === POD_HOST_ERROR.ENOENT)
      await assert.rejects(() => driver.drain('nobody'), (err) => err.code === POD_HOST_ERROR.ENOENT)
    })

    it('drain leaves a gone tombstone, emits drained exit, and the name can be spawned again', async () => {
      const driver = await fresh()
      const events = []
      driver.onEvent((event) => events.push(event))
      await driver.spawn(named('conf-e'))
      const drained = await driver.drain('conf-e')
      assert.equal(drained.state, POD_LIFECYCLE.GONE)
      assert.equal((await driver.status('conf-e')).state, POD_LIFECYCLE.GONE)
      const exit = events.find((e) => e.kind === POD_HOST_EVENT_KIND.EXIT)
      assert.equal(exit.data.reason, 'drained')
      assert.equal(exit.data.restartable, false)
      await driver.spawn(named('conf-e'))
    })

    it('lifecycle events follow legal transitions only', async () => {
      const driver = await fresh()
      const events = []
      driver.onEvent((event) => events.push(event))
      await driver.spawn(named('conf-f'))
      await driver.drain('conf-f')
      const lifecycle = events.filter((e) => e.kind === POD_HOST_EVENT_KIND.LIFECYCLE).map((e) => [e.data.from, e.data.to])
      assert.deepEqual(lifecycle[0], ['cold', 'booting'])
      assert.deepEqual(lifecycle.at(-1), ['draining', 'gone'])
    })

    it('list reports every pod including tombstones', async () => {
      const driver = await fresh()
      await driver.spawn(named('conf-g'))
      await driver.spawn(named('conf-h'))
      await driver.drain('conf-g')
      const byName = Object.fromEntries((await driver.list()).map((s) => [s.name, s.state]))
      assert.deepEqual(byName, { 'conf-g': 'gone', 'conf-h': 'registered' })
    })

    it('a verb the driver does not serve rejects with ELANE or ENOTSUP, never anything else', async () => {
      const driver = await fresh()
      await driver.spawn(named('conf-i'))
      const served = driver.capabilities().verbs
      for (const verb of ['exec', 'snapshot', 'restore']) {
        if (served.includes(verb)) continue
        await assert.rejects(
          () => (verb === 'exec' ? driver.exec('conf-i', ['true']) : driver[verb]('conf-i')),
          (err) => [POD_HOST_ERROR.ELANE, POD_HOST_ERROR.ENOTSUP].includes(err.code),
          `${verb} must be refused cleanly`,
        )
      }
    })

    it('send to an unknown pod is ENOENT', async () => {
      const driver = await fresh()
      if (!driver.capabilities().verbs.includes('send')) return
      await assert.rejects(() => driver.send('nobody', { payload: 1 }), (err) => err.code === POD_HOST_ERROR.ENOENT)
    })
  })
}
