import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { VmPodHost } from '../src/host-pod.mjs'

const DEMO_OPTS = {
  kernelImage: '/boot/vmlinux',
  rootfs: '/vm/demo/rootfs.ext4',
  tap: { hostDevName: 'tap-demo' },
  vsock: { guestCid: 3, udsPath: '/vm/demo/v.sock' },
  limits: { vcpus: 1, memMib: 128 },
  snapshotDir: '/vm/demo/snapshots',
  idleTimeoutMs: 0,
  dryRun: true,
}

describe('VmPodHost', () => {
  it('advertises microvm runtime metadata', async () => {
    const host = new VmPodHost({ dryRun: true })
    await host.start()
    assert.deepEqual(host.metadata, {
      runtimeClasses: ['microvm'],
      shellBackend: 'vm-console',
      deploymentSupport: { canDeploy: true },
    })
    assert.equal(host.metadata, host.toJSON().metadata)
  })

  it('spawn records the jailer argv before the VmPod boot sequence, in dryRun', async () => {
    const host = new VmPodHost({ dryRun: true, jailer: { uid: 123, gid: 100 } })
    await host.start()
    const vmPod = await host.spawn('demo', DEMO_OPTS)

    assert.equal(vmPod.state, 'booting')
    assert.equal(vmPod.plannedCommands[0].description, 'spawn jailer (fronting firecracker)')
    assert.deepEqual(vmPod.plannedCommands[0].argv.slice(0, 5), ['jailer', '--id', 'demo', '--exec-file', '/usr/bin/firecracker'])
    // TAP setup commands follow the jailer spawn.
    assert.equal(vmPod.plannedCommands[1].argv[0], 'ip')
  })

  it('refuses to spawn the same name twice', async () => {
    const host = new VmPodHost({ dryRun: true })
    await host.start()
    await host.spawn('demo', DEMO_OPTS)
    await assert.rejects(() => host.spawn('demo', DEMO_OPTS), /already spawned/)
  })

  it('status() reports state per VM', async () => {
    const host = new VmPodHost({ dryRun: true })
    await host.start()
    const vmPod = await host.spawn('demo', DEMO_OPTS)
    vmPod.markRegistered('guest-1')
    assert.deepEqual(host.status(), { demo: { state: 'registered', podId: 'guest-1', dryRun: true } })
  })

  it('exec in dryRun records a planned vsock call and never touches the network', async () => {
    const host = new VmPodHost({ dryRun: true })
    await host.start()
    const vmPod = await host.spawn('demo', DEMO_OPTS)
    vmPod.markRegistered('guest-1')

    const result = await host.exec('demo', ['ls', '/data'])
    assert.deepEqual(result, { stdout: '', stderr: '', code: 0 })
    const last = vmPod.plannedCommands.at(-1)
    assert.deepEqual(last.argv, ['vsock-exec', 'ls', '/data'])
  })

  it('exec throws for an unreachable (not registered) VM', async () => {
    const host = new VmPodHost({ dryRun: true })
    await host.start()
    await host.spawn('demo', DEMO_OPTS)
    await assert.rejects(() => host.exec('demo', ['ls']), /not reachable/)
  })

  it('snapshot pauses a registered VM then snapshots it', async () => {
    const host = new VmPodHost({ dryRun: true })
    await host.start()
    const vmPod = await host.spawn('demo', DEMO_OPTS)
    vmPod.markRegistered('guest-1')

    await host.snapshot('demo')
    assert.equal(vmPod.state, 'snapshotted')
  })

  it('restore moves a snapshotted VM to restoring', async () => {
    const host = new VmPodHost({ dryRun: true })
    await host.start()
    const vmPod = await host.spawn('demo', DEMO_OPTS)
    vmPod.markRegistered('guest-1')
    await host.snapshot('demo')

    await host.restore('demo')
    assert.equal(vmPod.state, 'restoring')
  })

  it('drain removes the VM from the host after tearing it down', async () => {
    const host = new VmPodHost({ dryRun: true })
    await host.start()
    const vmPod = await host.spawn('demo', DEMO_OPTS)
    vmPod.markRegistered('guest-1')

    await host.drain('demo')
    assert.equal(vmPod.state, 'cold')
    assert.deepEqual(host.status(), {})
  })

  it('operations on an unknown VM name throw', async () => {
    const host = new VmPodHost({ dryRun: true })
    await host.start()
    await assert.rejects(() => host.snapshot('nope'), /no VM named/)
    await assert.rejects(() => host.restore('nope'), /no VM named/)
    await assert.rejects(() => host.drain('nope'), /no VM named/)
  })
})
