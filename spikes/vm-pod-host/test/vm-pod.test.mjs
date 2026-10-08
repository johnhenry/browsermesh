import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { VmPod, VmPodStateError, STATES } from '../src/vm-pod.mjs'

/** Build a VmPod in dryRun mode with a never-invoked client/exec (dryRun must never call either). */
function makePod(overrides = {}) {
  const client = new Proxy({}, { get() { throw new Error('dryRun must never call the real client') } })
  const exec = async () => { throw new Error('dryRun must never call the real exec') }
  return new VmPod({
    client,
    exec,
    id: 'demo',
    kernelImage: '/boot/vmlinux',
    rootfs: '/vm/demo/rootfs.ext4',
    tap: { hostDevName: 'tap-demo', guestMac: 'AA:BB:CC:DD:EE:01' },
    vsock: { guestCid: 3, udsPath: '/vm/demo/v.sock' },
    limits: { vcpus: 1, memMib: 128 },
    snapshotDir: '/vm/demo/snapshots',
    idleTimeoutMs: 0, // disable auto-pause timer noise in tests
    dryRun: true,
    ...overrides,
  })
}

describe('VmPod state machine', () => {
  it('starts cold', () => {
    const pod = makePod()
    assert.equal(pod.state, 'cold')
  })

  it('exposes all §5.3 states', () => {
    assert.deepEqual([...STATES], ['cold', 'booting', 'registered', 'serving', 'paused', 'snapshotted', 'restoring', 'draining'])
  })

  it('rejects an invalid transition', () => {
    const pod = makePod()
    assert.throws(() => pod.markRegistered('guest-1'), VmPodStateError) // cold -> registered is not allowed
  })

  it('cold boot runs host setup then the full pre-boot API sequence then start, in order', async () => {
    const pod = makePod()
    const transitions = []
    pod.on('transition', (t) => transitions.push(t))

    await pod.boot()
    assert.equal(pod.state, 'booting')

    assert.deepEqual(pod.plannedCommands.map((c) => c.argv), [
      ['ip', 'tuntap', 'add', 'tap-demo', 'mode', 'tap'],
      ['ip', 'link', 'set', 'tap-demo', 'up'],
      ['nft', 'add', 'rule', 'firecracker', 'filter', 'iifname', 'tap-demo', 'oifname', 'eth0', 'accept'],
    ])

    assert.deepEqual(pod.plannedApiCalls.map((c) => c.api), [
      'putMachineConfig', 'putBootSource', 'putDrive', 'putNetworkInterface', 'putVsock', 'start',
    ])

    const machineConfig = pod.plannedApiCalls[0].args
    assert.deepEqual(machineConfig, { vcpu_count: 1, mem_size_mib: 128, track_dirty_pages: true })

    const bootSource = pod.plannedApiCalls[1].args
    assert.equal(bootSource.kernel_image_path, '/boot/vmlinux')
    assert.match(bootSource.boot_args, /console=ttyS0/)

    const [driveId, driveOpts] = pod.plannedApiCalls[2].args
    assert.equal(driveId, 'rootfs')
    assert.equal(driveOpts.path_on_host, '/vm/demo/rootfs.ext4')
    assert.equal(driveOpts.is_root_device, true)

    const [ifaceId, ifaceOpts] = pod.plannedApiCalls[3].args
    assert.equal(ifaceId, 'eth0')
    assert.equal(ifaceOpts.host_dev_name, 'tap-demo')
    assert.equal(ifaceOpts.guest_mac, 'AA:BB:CC:DD:EE:01')

    assert.deepEqual(pod.plannedApiCalls[4].args, { guest_cid: 3, uds_path: '/vm/demo/v.sock' })
    assert.equal(pod.plannedApiCalls[5].args, undefined)

    assert.deepEqual(transitions, [{ from: 'cold', to: 'booting', reason: 'boot() called' }])
  })

  it('markRegistered moves booting -> registered and records the guest podId', async () => {
    const pod = makePod()
    await pod.boot()
    pod.markRegistered('guest-pod-123')
    assert.equal(pod.state, 'registered')
    assert.equal(pod.podId, 'guest-pod-123')
  })

  it('serving round-trip: registered -> serving -> registered', async () => {
    const pod = makePod()
    await pod.boot()
    pod.markRegistered('guest-1')
    pod.beginServing()
    assert.equal(pod.state, 'serving')
    pod.endServing()
    assert.equal(pod.state, 'registered')
  })

  it('pause + snapshot: registered -> paused -> snapshotted, with snapshot then VMM kill', async () => {
    const pod = makePod()
    await pod.boot()
    pod.markRegistered('guest-1')
    pod.plannedApiCalls.length = 0
    pod.plannedCommands.length = 0

    await pod.pause()
    assert.equal(pod.state, 'paused')
    assert.deepEqual(pod.plannedApiCalls.map((c) => c.api), ['pause'])

    await pod.snapshot()
    assert.equal(pod.state, 'snapshotted')
    assert.deepEqual(pod.plannedApiCalls.map((c) => c.api), ['pause', 'createSnapshot'])
    assert.deepEqual(pod.plannedApiCalls[1].args, {
      snapshot_path: '/vm/demo/snapshots/demo.vmstate',
      mem_file_path: '/vm/demo/snapshots/demo.mem',
      snapshot_type: 'Full',
    })
    assert.deepEqual(pod.plannedCommands.map((c) => c.argv), [['pkill', '-f', '--id demo']])
  })

  it('restore: snapshotted -> restoring, re-runs TAP setup, loads snapshot, resumes', async () => {
    const pod = makePod()
    await pod.boot()
    pod.markRegistered('guest-1')
    await pod.pause()
    await pod.snapshot()
    pod.plannedApiCalls.length = 0
    pod.plannedCommands.length = 0

    await pod.restore()
    assert.equal(pod.state, 'restoring')

    assert.deepEqual(pod.plannedCommands.map((c) => c.argv), [
      ['ip', 'tuntap', 'add', 'tap-demo', 'mode', 'tap'],
      ['ip', 'link', 'set', 'tap-demo', 'up'],
      ['nft', 'add', 'rule', 'firecracker', 'filter', 'iifname', 'tap-demo', 'oifname', 'eth0', 'accept'],
      // #221: the killed VMM leaves its vsock socket behind; loadSnapshot fails
      // with "Address already in use" unless it is unlinked first.
      ['rm', '-f', '/vm/demo/v.sock'],
    ])
    assert.deepEqual(pod.plannedApiCalls.map((c) => c.api), ['loadSnapshot', 'resume'])
    assert.deepEqual(pod.plannedApiCalls[0].args, {
      snapshot_path: '/vm/demo/snapshots/demo.vmstate',
      mem_backend: { backend_type: 'File', backend_path: '/vm/demo/snapshots/demo.mem' },
      resume_vm: false,
    })

    pod.markRegistered('guest-1')
    assert.equal(pod.state, 'registered')
  })

  it('restore starts a fresh VMM (vmmArgv) after unlinking the stale vsock socket and before loadSnapshot (#221)', async () => {
    const vmmArgv = ['jailer', '--id', 'demo', '--daemonize']
    const pod = makePod({ vmmArgv })
    await pod.boot()
    pod.markRegistered('guest-1')
    await pod.pause()
    await pod.snapshot()
    pod.plannedApiCalls.length = 0
    pod.plannedCommands.length = 0

    await pod.restore()
    const argvs = pod.plannedCommands.map((c) => c.argv)
    const rmAt = argvs.findIndex((a) => a[0] === 'rm')
    const vmmAt = argvs.findIndex((a) => a[0] === 'jailer')
    assert.ok(rmAt >= 0 && vmmAt > rmAt, 'rm of the stale socket precedes VMM start')
    assert.deepEqual(argvs[vmmAt], vmmArgv)
    assert.equal(vmmAt, argvs.length - 1, 'VMM start is the last host command before the API calls')
  })

  it('boot also starts the VMM first when vmmArgv is given; without it boot is unchanged', async () => {
    const withVmm = makePod({ vmmArgv: ['jailer', '--id', 'demo'] })
    await withVmm.boot()
    assert.deepEqual(withVmm.plannedCommands[0].argv, ['jailer', '--id', 'demo'])
    const without = makePod()
    await without.boot()
    assert.equal(without.plannedCommands.some((c) => c.argv[0] === 'jailer'), false)
  })

  it('drain: registered -> draining -> cold, notifies peers then kills VMM then tears down TAP', async () => {
    const pod = makePod()
    await pod.boot()
    pod.markRegistered('guest-1')
    pod.plannedApiCalls.length = 0
    pod.plannedCommands.length = 0

    const notified = []
    pod.on('drain:peers-notified', (info) => notified.push(info))

    await pod.drain()
    assert.equal(pod.state, 'cold')
    assert.equal(notified.length, 1)
    assert.equal(notified[0].id, 'demo')

    assert.deepEqual(pod.plannedCommands.map((c) => c.argv), [
      ['pkill', '-f', '--id demo'],
      ['ip', 'link', 'set', 'tap-demo', 'down'],
      ['ip', 'tuntap', 'del', 'tap-demo', 'mode', 'tap'],
    ])
    assert.equal(pod.plannedApiCalls.length, 0)
  })

  it('emits a named event per transition in addition to "transition"', async () => {
    const pod = makePod()
    const seen = []
    for (const s of STATES) pod.on(s, () => seen.push(s))
    await pod.boot()
    assert.deepEqual(seen, ['booting'])
  })

  it('rejects snapshot from a non-paused state', async () => {
    const pod = makePod()
    await pod.boot()
    pod.markRegistered('guest-1')
    await assert.rejects(() => pod.snapshot(), VmPodStateError)
  })

  it('auto-pauses after idleTimeoutMs of registered inactivity', async () => {
    const pod = makePod({ idleTimeoutMs: 20 })
    await pod.boot()
    pod.markRegistered('guest-1')
    await new Promise((resolve) => pod.once('paused', resolve))
    assert.equal(pod.state, 'paused')
  })
})
