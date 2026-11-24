// The whole lifecycle (cold boot, pause, snapshot, restore, drain) of a
// jailed VmPod, with a real FirecrackerClient talking HTTP over a real unix
// socket to FakeFirecrackerServer. No VM is booted: the host commands go to
// a recording exec and the process table is a fake. What this checks is the
// exact sequence and shape of what Firecracker would be sent, and what the
// host would be told to do around it. It does NOT show Firecracker accepts it.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { VmPod } from '../src/vm-pod.mjs'
import { FirecrackerClient } from '../src/firecracker-client.mjs'
import { FakeFirecrackerServer } from './fake-firecracker-server.mjs'

const ROOT = '/srv/jailer/firecracker/demo/root'

describe('jailed VmPod against a fake Firecracker API', () => {
  let dir
  let server
  let ran
  let killed
  let pod

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vm-lifecycle-'))
    server = new FakeFirecrackerServer(path.join(dir, 'fc.sock'))
    await server.listen()
    ran = []
    killed = []
    pod = new VmPod({
      client: new FirecrackerClient({ socketPath: path.join(dir, 'fc.sock') }),
      exec: async (argv) => { ran.push(argv); return { stdout: '', stderr: '', code: 0 } },
      id: 'demo',
      kernelImage: '/boot/vmlinux',
      tap: { hostDevName: 'tap-demo', guestMac: 'AA:BB:CC:DD:EE:01' },
      vsock: { guestCid: 3, udsPath: '/unused/in/a/jail.vsock' },
      limits: { vcpus: 2, memMib: 256, netRateLimiter: { bandwidth: { size: 1000, refill_time: 100 } } },
      idleTimeoutMs: 0,
      jail: { root: ROOT, uid: 100003, gid: 100003 },
      rootfsBase: '/vm/base/alpine.ext4',
      vmmArgv: ['jailer', '--id', 'demo', '--daemonize'],
      vmmPidFile: `${ROOT}/firecracker.pid`,
      signalingUrl: 'wss://signal.example.com/ws',
      proc: {
        readFile: async (file) => (file.endsWith('.pid') ? '4242\n' : ['/usr/bin/firecracker', '--id', 'demo'].join('\0') + '\0'),
        kill: (pid, signal) => { killed.push([pid, signal]) },
      },
    })
  })
  after(async () => {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  })

  const calls = () => server.requests.map((r) => `${r.method} ${r.path}`)

  it('cold boot configures the VM in the order Firecracker requires, with jail-relative paths', async () => {
    await pod.boot()
    assert.deepEqual(calls(), [
      'PUT /machine-config', 'PUT /boot-source', 'PUT /drives/rootfs',
      'PUT /network-interfaces/eth0', 'PUT /vsock', 'PUT /actions',
    ])
    const byPath = Object.fromEntries(server.requests.map((r) => [r.path, r.body]))
    assert.deepEqual(byPath['/machine-config'], { vcpu_count: 2, mem_size_mib: 256, track_dirty_pages: true })
    assert.equal(byPath['/boot-source'].kernel_image_path, 'vmlinux')
    assert.match(byPath['/boot-source'].boot_args, /^console=ttyS0 .* root=\/dev\/vda rw init=\/init ip=10\.200\.0\.2::10\.200\.0\.1:255\.255\.255\.252::eth0:off signaling_url=wss:\/\/signal\.example\.com\/ws$/)
    assert.equal(byPath['/drives/rootfs'].path_on_host, 'rootfs.ext4')
    assert.equal(byPath['/drives/rootfs'].is_root_device, true)
    assert.equal(byPath['/network-interfaces/eth0'].host_dev_name, 'tap-demo')
    assert.deepEqual(byPath['/network-interfaces/eth0'].rx_rate_limiter, { bandwidth: { size: 1000, refill_time: 100 } })
    assert.equal(byPath['/vsock'].uds_path, 'v.sock')
    assert.deepEqual(byPath['/actions'], { action_type: 'InstanceStart' })
  })

  it('starts the VMM first, stages the jail, and only then sets up the network', () => {
    const verbs = ran.map((argv) => argv[0])
    assert.equal(verbs[0], 'jailer')
    assert.deepEqual(verbs.slice(1, 6), ['cp', 'cp', 'chown', 'chmod', 'chmod'])
    assert.equal(verbs[6], 'ip')
  })

  it('pause then snapshot sends the jail-relative file names, then stops the VMM by pid', async () => {
    server.requests.length = 0
    ran.length = 0
    pod.markRegistered('guest-1')
    await pod.pause()
    await pod.snapshot()
    assert.deepEqual(calls(), ['PATCH /vm', 'PUT /snapshot/create'])
    assert.deepEqual(server.requests[1].body, { snapshot_path: 'vmstate', mem_file_path: 'mem', snapshot_type: 'Full' })
    assert.deepEqual(killed, [[4242, 'SIGTERM']])
    assert.equal(pod.state, 'snapshotted')
  })

  it('restore re-installs the network, clears the stale socket, starts a fresh VMM, loads and resumes', async () => {
    server.requests.length = 0
    ran.length = 0
    await pod.restore()
    assert.deepEqual(calls(), ['PUT /snapshot/load', 'PATCH /vm'])
    assert.deepEqual(server.requests[0].body, {
      snapshot_path: 'vmstate', mem_backend: { backend_type: 'File', backend_path: 'mem' }, resume_vm: false,
    })
    const lines = ran.map((argv) => argv.join(' '))
    const rm = lines.indexOf(`rm -f ${ROOT}/v.sock`)
    const jailer = lines.indexOf('jailer --id demo --daemonize')
    assert.ok(rm >= 0 && jailer > rm, 'the stale socket is removed before the new VMM starts')
    assert.ok(lines.findIndex((l) => l.startsWith('nft delete table')) < lines.findIndex((l) => l.startsWith('nft add table')))
    assert.equal(pod.state, 'restoring')
  })

  it('drain stops the VMM by pid and removes the network, and the pod is cold again', async () => {
    pod.markRegistered('guest-1')
    killed.length = 0
    ran.length = 0
    await pod.drain()
    assert.deepEqual(killed, [[4242, 'SIGTERM']])
    assert.equal(ran.at(-1).join(' '), 'ip tuntap del tap-demo mode tap')
    assert.equal(pod.state, 'cold')
  })
})
