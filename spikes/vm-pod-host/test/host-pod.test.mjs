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
    assert.equal(vmPod.plannedCommands[0].description, 'start a fresh jailed firecracker process')
    assert.deepEqual(vmPod.plannedCommands[0].argv.slice(0, 5), ['jailer', '--id', 'demo', '--exec-file', '/usr/bin/firecracker'])
    assert.ok(vmPod.plannedCommands[0].argv.includes('--daemonize'), 'VmPod starts the VMM, so it must return')
    // Network setup follows the jailer spawn.
    assert.equal(vmPod.plannedCommands[1].argv[0], 'ip')
  })

  it('runs each VMM as its own non-root identity unless the operator names one', async () => {
    const host = new VmPodHost({ dryRun: true })
    await host.start()
    const a = await host.spawn('a', { ...DEMO_OPTS, vsock: { guestCid: 3, udsPath: '/vm/a.sock' } })
    const b = await host.spawn('b', { ...DEMO_OPTS, vsock: { guestCid: 4, udsPath: '/vm/b.sock' } })
    const ids = (pod) => {
      const argv = pod.plannedCommands[0].argv
      return [argv[argv.indexOf('--uid') + 1], argv[argv.indexOf('--gid') + 1]]
    }
    assert.deepEqual(ids(a), ['100003', '100003'])
    assert.deepEqual(ids(b), ['100004', '100004'])
  })

  it('refuses an operator-supplied root uid or gid for the jailer', async () => {
    for (const jailer of [{ uid: 0, gid: 100 }, { uid: 100, gid: 0 }]) {
      const host = new VmPodHost({ dryRun: true, jailer })
      await host.start()
      await assert.rejects(() => host.spawn('demo', DEMO_OPTS), /non-zero/)
    }
    // A base that would land a VM on uid 0 is refused too (cid >= 3 keeps this unreachable, but check the rule).
    const host = new VmPodHost({ dryRun: true, jailer: { uidBase: -3, gidBase: 100 } })
    await host.start()
    await assert.rejects(() => host.spawn('demo', DEMO_OPTS), /non-zero/)
  })

  it('refuses a name the jailer would reject, before running anything', async () => {
    const host = new VmPodHost({ dryRun: true })
    await host.start()
    await assert.rejects(() => host.spawn('has.dot', DEMO_OPTS), /cannot be a VM id/)
    await assert.rejects(() => host.spawn('under_score', DEMO_OPTS), /cannot be a VM id/)
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
