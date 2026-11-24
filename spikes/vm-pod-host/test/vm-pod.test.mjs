import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { VmPod, VmPodStateError, STATES } from '../src/vm-pod.mjs'

/** The host commands a pod's network setup/teardown emit, for assertions that do not care about every nft rule. */
function networkCommands(pod, which) {
  return pod.plannedCommands.map((c) => c.argv).filter((a) => (which === 'ip' ? a[0] === 'ip' : a[0] === 'nft'))
}

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
    vmmPidFile: '/srv/jailer/firecracker/demo/root/firecracker.pid',
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

    assert.deepEqual(networkCommands(pod, 'ip'), [
      ['ip', 'tuntap', 'add', 'tap-demo', 'mode', 'tap'],
      ['ip', 'addr', 'add', '10.200.0.1/30', 'dev', 'tap-demo'],
      ['ip', 'link', 'set', 'tap-demo', 'up'],
    ])
    // Default policy is a per-pod table that drops private destinations,
    // not a blanket TAP -> uplink accept.
    const nft = networkCommands(pod, 'nft').map((a) => a.join(' ')).join('\n')
    assert.match(nft, /add table inet fc-demo/)
    assert.match(nft, /169\.254\.0\.0\/16/)
    assert.doesNotMatch(nft, /add rule firecracker filter/)

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
    assert.deepEqual(pod.plannedCommands.map((c) => c.argv), [['kill-vmm', '/srv/jailer/firecracker/demo/root/firecracker.pid']])
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

    const restoreArgvs = pod.plannedCommands.map((c) => c.argv)
    // Whatever survived the snapshot is removed first, then a fresh set installed.
    const ipVerbs = restoreArgvs.filter((a) => a[0] === 'ip').map((a) => a.slice(0, 3).join(' '))
    assert.deepEqual(ipVerbs, ['ip link set', 'ip tuntap del', 'ip tuntap add', 'ip addr add', 'ip link set'])
    assert.deepEqual(restoreArgvs[0], ['nft', 'delete', 'table', 'inet', 'fc-demo'])
    // #221: the killed VMM leaves its vsock socket behind; loadSnapshot fails
    // with "Address already in use" unless it is unlinked first.
    assert.deepEqual(restoreArgvs.at(-1), ['rm', '-f', '/vm/demo/v.sock'])
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
      ['kill-vmm', '/srv/jailer/firecracker/demo/root/firecracker.pid'],
      ['nft', 'delete', 'table', 'inet', 'fc-demo'],
      ['ip', 'link', 'set', 'tap-demo', 'down'],
      ['ip', 'tuntap', 'del', 'tap-demo', 'mode', 'tap'],
    ])
    assert.equal(pod.plannedApiCalls.length, 0)
  })

  describe('stopping the VMM', () => {
    /** A real (non-dry-run) pod whose process table is a fake. */
    function realPod({ pidFileContents, cmdline, killed = [] }) {
      const exec = async () => ({ stdout: '', stderr: '', code: 0 })
      return {
        killed,
        pod: makePod({
          dryRun: false,
          client: new Proxy({}, { get: () => async () => undefined }),
          exec,
          proc: {
            readFile: async (path) => {
              if (path.endsWith('.pid')) return pidFileContents
              return cmdline
            },
            kill: (pid, signal) => { killed.push([pid, signal]) },
          },
        }),
      }
    }

    it('stops exactly the process recorded in the pid file when its command line carries this pod id', async () => {
      const { pod, killed } = realPod({
        pidFileContents: '4242\n',
        cmdline: ['/usr/bin/firecracker', '--id', 'demo', '--api-sock', '/run/firecracker.socket'].join('\0') + '\0',
      })
      await pod.boot()
      pod.markRegistered('g')
      await pod.drain()
      assert.deepEqual(killed, [[4242, 'SIGTERM']])
    })

    it('never stops a process whose command line only has this id as a prefix of another pod id', async () => {
      const { pod, killed } = realPod({
        pidFileContents: '4242\n',
        cmdline: ['/usr/bin/firecracker', '--id', 'demo2'].join('\0') + '\0',
      })
      await pod.boot()
      pod.markRegistered('g')
      await assert.rejects(() => pod.drain(), /does not belong to/)
      assert.deepEqual(killed, [])
    })

    it('refuses a pid file that does not hold a plain process id', async () => {
      for (const contents of ['', '0', '1', '-1', '12 34', 'abc']) {
        const { pod, killed } = realPod({ pidFileContents: contents, cmdline: '' })
        await pod.boot()
        pod.markRegistered('g')
        await assert.rejects(() => pod.drain(), /pid file/)
        assert.deepEqual(killed, [], `contents ${JSON.stringify(contents)}`)
      }
    })
  })

  describe('jailed (chroot) paths', () => {
    const ROOT = '/srv/jailer/firecracker/demo/root'
    const jailed = (overrides = {}) => makePod({
      jail: { root: ROOT, uid: 100003, gid: 100003 },
      kernelImage: '/boot/vmlinux',
      rootfs: undefined,
      rootfsBase: '/vm/base/alpine.ext4',
      vmmArgv: ['jailer', '--id', 'demo', '--daemonize'],
      signalingUrl: 'wss://signal.example.com/ws',
      ...overrides,
    })

    it('stages the kernel and a private rootfs inside the jail after the VMM starts, before the network', async () => {
      const pod = jailed()
      await pod.boot()
      const argvs = pod.plannedCommands.map((c) => c.argv)
      assert.deepEqual(argvs[0], ['jailer', '--id', 'demo', '--daemonize'])
      assert.deepEqual(argvs.slice(1, 6).map((a) => a[0]), ['cp', 'cp', 'chown', 'chmod', 'chmod'])
      assert.equal(argvs[6][0], 'ip', 'network setup follows staging')
      assert.ok(!argvs.some((a) => a[0] === 'mkdir'), 'no stray directory outside the jail is created')
    })

    it('gives Firecracker paths as the jail sees them, and the guest its address and signaling URL', async () => {
      const pod = jailed()
      await pod.boot()
      const call = (api) => pod.plannedApiCalls.find((c) => c.api === api).args
      assert.equal(call('putBootSource').kernel_image_path, 'vmlinux')
      assert.equal(call('putBootSource').boot_args.includes('ip=10.200.0.2::10.200.0.1:255.255.255.252::eth0:off'), true)
      assert.match(call('putBootSource').boot_args, /signaling_url=wss:\/\/signal\.example\.com\/ws$/)
      assert.equal(call('putDrive')[1].path_on_host, 'rootfs.ext4')
      assert.equal(call('putVsock').uds_path, 'v.sock')
    })

    it('the host reaches the vsock socket and the snapshot files under the jail root', async () => {
      const pod = jailed()
      assert.equal(pod.vsockUdsPath, `${ROOT}/v.sock`)
      assert.equal(pod.snapshotVmStatePath, `${ROOT}/vmstate`)
      assert.equal(pod.snapshotMemPath, `${ROOT}/mem`)
      await pod.boot()
      pod.markRegistered('g')
      await pod.pause()
      await pod.snapshot()
      assert.deepEqual(pod.plannedApiCalls.find((c) => c.api === 'createSnapshot').args, {
        snapshot_path: 'vmstate', mem_file_path: 'mem', snapshot_type: 'Full',
      })
    })

    it('restore unlinks the stale socket by its host path and loads the snapshot by its jail path', async () => {
      const pod = jailed()
      await pod.boot()
      pod.markRegistered('g')
      await pod.pause()
      await pod.snapshot()
      pod.plannedCommands.length = 0
      await pod.restore()
      assert.ok(pod.plannedCommands.some((c) => c.argv.join(' ') === `rm -f ${ROOT}/v.sock`))
      assert.deepEqual(pod.plannedApiCalls.find((c) => c.api === 'loadSnapshot').args.mem_backend, {
        backend_type: 'File', backend_path: 'mem',
      })
    })

    it('refuses a root identity for the jail', () => {
      assert.throws(() => jailed({ jail: { root: ROOT, uid: 0, gid: 1 } }), /uid/)
    })
  })

  describe('host commands fail closed', () => {
    it('does not configure or start the VM when installing the network rules fails', async () => {
      const apiCalls = []
      const pod = makePod({
        dryRun: false,
        client: new Proxy({}, { get: (_t, api) => async () => { apiCalls.push(api) } }),
        exec: async (argv) => (argv[0] === 'nft' && argv[1] === 'add' && argv[2] === 'rule'
          ? { stdout: '', stderr: 'Error: No such file or directory', code: 1 }
          : { stdout: '', stderr: '', code: 0 }),
      })
      await assert.rejects(() => pod.boot(), /host command failed \(exit 1\): nft add rule/)
      assert.deepEqual(apiCalls, [], 'no Firecracker call may follow a failed network setup')
    })
  })

  describe('rootfs', () => {
    it('copies the base image to the pod\'s own path before first boot, without overwriting', async () => {
      const pod = makePod({ rootfsBase: '/vm/base/alpine.ext4' })
      await pod.boot()
      const argvs = pod.plannedCommands.map((c) => c.argv)
      assert.deepEqual(argvs[0], ['mkdir', '-p', '--', '/vm/demo'])
      assert.deepEqual(argvs[1], ['cp', '--reflink=auto', '--no-clobber', '--', '/vm/base/alpine.ext4', '/vm/demo/rootfs.ext4'])
      assert.equal(pod.plannedApiCalls.find((c) => c.api === 'putDrive').args[1].path_on_host, '/vm/demo/rootfs.ext4')
    })

    it('refuses to attach the shared base image itself as a pod\'s writable disk', () => {
      assert.throws(
        () => makePod({ rootfsBase: '/vm/demo/rootfs.ext4' }),
        /shared base image/,
      )
    })
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
