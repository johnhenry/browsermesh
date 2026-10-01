/**
 * Tests for driver.mjs — the `PodHostDriver` adapter over WP3's
 * `VmPodHost` (issue #185's hosted-pods control surface, item 2).
 *
 * Everything runs in `dryRun: true`, so no Firecracker binary, no KVM and
 * no TAP device is needed: `VmPod` records the API calls and host commands
 * it would have made instead of making them, exactly as the rest of this
 * spike's suite does. One test drives a real `FakeFirecrackerServer` over
 * a unix socket to prove the adapter also works when the Firecracker API
 * calls really happen.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { VmPodHost } from '../src/host-pod.mjs'
import { createVmPodDriver } from '../src/driver.mjs'
import { FakeFirecrackerServer } from './fake-firecracker-server.mjs'
import {
  POD_HOST_ERROR,
  POD_HOST_EVENT_KIND,
  POD_LANE,
  POD_LIFECYCLE,
} from '../../../packages/browsermesh-pod/src/index.mjs'

const DRIVER_OPTS = {
  kernelImage: '/boot/vmlinux',
  rootfs: '/vm/default.ext4',
  snapshotDir: '/vm/snapshots',
  runDir: '/vm/run',
  idleTimeoutMs: 0,
  dryRun: true,
}

function spec(overrides = {}) {
  return { name: 'alpha', lane: POD_LANE.MICROVM, run: { kind: 'command', ref: '/bin/echo' }, ...overrides }
}

/** A started `VmPodHost` plus its driver, both in dryRun. */
async function makeDriver(driverOpts = {}) {
  const host = new VmPodHost({ dryRun: true })
  await host.start()
  return { host, driver: createVmPodDriver(host, { ...DRIVER_OPTS, ...driverOpts }) }
}

describe('createVmPodDriver', () => {
  it('requires a VmPodHost', () => {
    assert.throws(() => createVmPodDriver(), /VmPodHost is required/)
    assert.throws(() => createVmPodDriver({}), /VmPodHost is required/)
  })

  it('advertises the microvm lane and every verb except send', async () => {
    const { driver } = await makeDriver()
    assert.equal(driver.lane, POD_LANE.MICROVM)
    assert.deepEqual(driver.capabilities().verbs, [
      'spawn', 'status', 'exec', 'snapshot', 'restore', 'drain', 'list',
    ])
  })

  it('answers send with ENOTSUP, not ELANE — the lane could, WP3 has not', async () => {
    const { driver } = await makeDriver()
    await assert.rejects(driver.send('alpha', { payload: 1 }), (err) => {
      assert.equal(err.code, POD_HOST_ERROR.ENOTSUP)
      return true
    })
  })

  it('maps a podspec onto VmPodHost.spawn() options', async () => {
    const { host, driver } = await makeDriver()
    const status = await driver.spawn(spec({ limits: { vcpus: 2, memMib: 256 } }))

    assert.equal(status.name, 'alpha')
    assert.equal(status.lane, POD_LANE.MICROVM)
    assert.equal(status.state, POD_LIFECYCLE.BOOTING)

    const vmPod = host.vms.get('alpha')
    const machineConfig = vmPod.plannedApiCalls.find((call) => call.api === 'putMachineConfig')
    assert.equal(machineConfig.args.vcpu_count, 2)
    assert.equal(machineConfig.args.mem_size_mib, 256)
    const drive = vmPod.plannedApiCalls.find((call) => call.api === 'putDrive')
    assert.equal(drive.args[1].path_on_host, '/vm/default.ext4')
    const vsock = vmPod.plannedApiCalls.find((call) => call.api === 'putVsock')
    assert.equal(vsock.args.uds_path, '/vm/run/alpha.vsock')
    assert.equal(vsock.args.guest_cid, 3)
  })

  it('allocates a distinct vsock CID per pod', async () => {
    const { host, driver } = await makeDriver()
    await driver.spawn(spec({ name: 'one' }))
    await driver.spawn(spec({ name: 'two' }))
    const cids = ['one', 'two'].map((name) => host.vms.get(name)
      .plannedApiCalls.find((call) => call.api === 'putVsock').args.guest_cid)
    assert.deepEqual(cids, [3, 4])
  })

  it('passes a podspec rate limiter through to Firecracker', async () => {
    const { host, driver } = await makeDriver()
    await driver.spawn(spec({
      limits: { vcpus: 1, memMib: 128, netRateLimiter: { bandwidth: { size: 1, refill_time: 1 } } },
    }))
    const net = host.vms.get('alpha').plannedApiCalls.find((call) => call.api === 'putNetworkInterface')
    assert.deepEqual(net.args[1].rx_rate_limiter, { bandwidth: { size: 1, refill_time: 1 } })
  })

  it('resolves a rootfs run.kind through the catalog and refuses unknown refs', async () => {
    const { host, driver } = await makeDriver({ rootfsCatalog: { alpine: '/vm/alpine.ext4' } })
    await driver.spawn(spec({ run: { kind: 'rootfs', ref: 'alpine' } }))
    const drive = host.vms.get('alpha').plannedApiCalls.find((call) => call.api === 'putDrive')
    assert.equal(drive.args[1].path_on_host, '/vm/alpine.ext4')

    await assert.rejects(
      driver.spawn(spec({ name: 'beta', run: { kind: 'rootfs', ref: '/etc/shadow' } })),
      (err) => {
        assert.equal(err.code, POD_HOST_ERROR.ENOENT)
        assert.match(err.message, /no rootfs registered/)
        return true
      },
    )
  })

  it('refuses a non-microvm podspec with ELANE', async () => {
    const { driver } = await makeDriver()
    await assert.rejects(
      driver.spawn({ name: 'alpha', lane: 'isolate', run: { kind: 'skill', ref: 'greeter' } }),
      (err) => err.code === POD_HOST_ERROR.ELANE,
    )
  })

  it('reports EINVAL for an invalid podspec and EEXIST for a duplicate', async () => {
    const { driver } = await makeDriver()
    await assert.rejects(driver.spawn({ name: 'bad name' }), (err) => err.code === POD_HOST_ERROR.EINVAL)
    await driver.spawn(spec())
    await assert.rejects(driver.spawn(spec()), (err) => err.code === POD_HOST_ERROR.EEXIST)
  })

  it('identity-maps VmPod states onto POD_LIFECYCLE through a full lifecycle', async () => {
    const { host, driver } = await makeDriver()
    await driver.spawn(spec())
    assert.equal((await driver.status('alpha')).state, POD_LIFECYCLE.BOOTING)

    host.vms.get('alpha').markRegistered('guest-pod-1')
    const registered = await driver.status('alpha')
    assert.equal(registered.state, POD_LIFECYCLE.REGISTERED)
    assert.equal(registered.podId, 'guest-pod-1')

    assert.equal((await driver.snapshot('alpha')).state, POD_LIFECYCLE.SNAPSHOTTED)
    assert.equal((await driver.restore('alpha')).state, POD_LIFECYCLE.RESTORING)
    // A restored VM is only `registered` again once the guest re-announces
    // itself, and `VmPod` only allows draining from `registered`.
    host.vms.get('alpha').markRegistered('guest-pod-1')
    assert.equal((await driver.drain('alpha')).state, POD_LIFECYCLE.GONE)
    // Drained VMs are forgotten by VmPodHost; the driver's tombstone is
    // what keeps `gone` reportable instead of ENOENT.
    assert.equal((await driver.status('alpha')).state, POD_LIFECYCLE.GONE)
  })

  it('execs through the guest vsock responder and reports EBUSY when unreachable', async () => {
    const { host, driver } = await makeDriver()
    await driver.spawn(spec())
    await assert.rejects(driver.exec('alpha', ['ls']), (err) => {
      assert.equal(err.code, POD_HOST_ERROR.EBUSY)
      return true
    })
    host.vms.get('alpha').markRegistered('guest-pod-1')
    assert.deepEqual(await driver.exec('alpha', ['ls', '/data']), { stdout: '', stderr: '', code: 0 })
    const planned = host.vms.get('alpha').plannedCommands.at(-1)
    assert.deepEqual(planned.argv, ['vsock-exec', 'ls', '/data'])
  })

  it('reports ENOENT for an unknown pod on every named verb', async () => {
    const { driver } = await makeDriver()
    for (const call of [
      () => driver.status('ghost'),
      () => driver.exec('ghost', ['ls']),
      () => driver.snapshot('ghost'),
      () => driver.restore('ghost'),
      () => driver.drain('ghost'),
    ]) {
      await assert.rejects(call(), (err) => err.code === POD_HOST_ERROR.ENOENT)
    }
  })

  it('republishes VmPod transitions as protocol lifecycle events', async () => {
    const { host, driver } = await makeDriver()
    /** @type {object[]} */
    const events = []
    const off = driver.onEvent((event) => events.push(event))
    assert.equal(typeof driver.onEvent('nope'), 'function')

    await driver.spawn(spec())
    host.vms.get('alpha').markRegistered('guest-1')
    await driver.drain('alpha')

    const lifecycle = events
      .filter((event) => event.kind === POD_HOST_EVENT_KIND.LIFECYCLE)
      .map((event) => `${event.data.from}->${event.data.to}`)
    assert.deepEqual(lifecycle, ['booting->registered', 'registered->draining', 'draining->cold'])
    assert.equal(events.filter((event) => event.kind === POD_HOST_EVENT_KIND.EXIT).length, 1)

    off()
    const before = events.length
    await driver.spawn(spec({ name: 'beta' }))
    assert.equal(events.length, before)
  })

  it('surfaces a VmPod state-machine refusal as EBUSY', async () => {
    const { driver } = await makeDriver()
    await driver.spawn(spec())
    // `VmPod` only drains from `registered`; this one is still `booting`.
    await assert.rejects(driver.drain('alpha'), (err) => {
      assert.equal(err.code, POD_HOST_ERROR.EBUSY)
      assert.match(err.message, /invalid transition booting -> draining/)
      return true
    })
  })

  it('lists live pods and tombstones together', async () => {
    const { host, driver } = await makeDriver()
    await driver.spawn(spec({ name: 'one' }))
    await driver.spawn(spec({ name: 'two' }))
    host.vms.get('two').markRegistered('guest-2')
    await driver.drain('two')
    const list = await driver.list()
    assert.deepEqual(
      list.map((pod) => [pod.name, pod.state]).sort(),
      [['one', 'booting'], ['two', 'gone']],
    )
  })

  it('works against a real FakeFirecrackerServer, not just in dryRun', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'vm-pod-driver-'))
    const socketPath = path.join(dir, 'fc.sock')
    const server = new FakeFirecrackerServer(socketPath)
    await server.listen()
    try {
      /** @type {string[][]} */
      const ran = []
      const host = new VmPodHost({ exec: async (argv) => { ran.push(argv); return { stdout: '', stderr: '', code: 0 } } })
      await host.start()
      const driver = createVmPodDriver(host, {
        ...DRIVER_OPTS,
        dryRun: false,
        spawnOptions: () => ({ socketPath }),
      })

      const status = await driver.spawn(spec({ limits: { vcpus: 1, memMib: 128 } }))
      assert.equal(status.state, POD_LIFECYCLE.BOOTING)
      const paths = server.requests.map((request) => request.path)
      assert.ok(paths.includes('/machine-config'), paths.join(','))
      assert.ok(paths.includes('/boot-source'))
      assert.ok(paths.includes('/actions'))
      assert.ok(ran.some((argv) => argv[0] === 'jailer'))
    } finally {
      await server.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
