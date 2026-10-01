import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FirecrackerClient, FirecrackerApiError } from '../src/firecracker-client.mjs'
import { FakeFirecrackerServer } from './fake-firecracker-server.mjs'

const socketPath = join(tmpdir(), `fc-test-${process.pid}.sock`)

describe('FirecrackerClient', () => {
  /** @type {FakeFirecrackerServer} */
  let server
  /** @type {FirecrackerClient} */
  let client

  before(async () => {
    server = new FakeFirecrackerServer(socketPath)
    await server.listen()
    client = new FirecrackerClient({ socketPath })
  })

  after(async () => {
    await server.close()
  })

  beforeEach(() => {
    server.requests.length = 0
  })

  it('requires a socketPath', () => {
    assert.throws(() => new FirecrackerClient({}), /socketPath is required/)
  })

  it('putMachineConfig sends PUT /machine-config', async () => {
    await client.putMachineConfig({ vcpu_count: 2, mem_size_mib: 256, smt: false })
    assert.equal(server.requests.length, 1)
    assert.equal(server.requests[0].method, 'PUT')
    assert.equal(server.requests[0].path, '/machine-config')
    assert.deepEqual(server.requests[0].body, { vcpu_count: 2, mem_size_mib: 256, smt: false })
  })

  it('getMachineConfig sends GET /machine-config and parses the body', async () => {
    const config = await client.getMachineConfig()
    assert.equal(server.requests[0].method, 'GET')
    assert.equal(server.requests[0].path, '/machine-config')
    assert.equal(config.vcpu_count, 1)
  })

  it('putBootSource sends PUT /boot-source with optional fields omitted when absent', async () => {
    await client.putBootSource({ kernel_image_path: '/boot/vmlinux' })
    assert.deepEqual(server.requests[0].body, { kernel_image_path: '/boot/vmlinux' })
  })

  it('putBootSource includes boot_args and initrd_path when given', async () => {
    await client.putBootSource({ kernel_image_path: '/boot/vmlinux', boot_args: 'console=ttyS0', initrd_path: '/boot/initrd' })
    assert.deepEqual(server.requests[0].body, {
      kernel_image_path: '/boot/vmlinux', boot_args: 'console=ttyS0', initrd_path: '/boot/initrd',
    })
  })

  it('putDrive sends PUT /drives/{id} with drive_id folded into the body', async () => {
    await client.putDrive('rootfs', { path_on_host: '/vm/rootfs.ext4', is_root_device: true, is_read_only: false })
    assert.equal(server.requests[0].path, '/drives/rootfs')
    assert.deepEqual(server.requests[0].body, {
      drive_id: 'rootfs', path_on_host: '/vm/rootfs.ext4', is_root_device: true, is_read_only: false,
    })
  })

  it('putDrive includes rate_limiter when given', async () => {
    const rate_limiter = { bandwidth: { size: 1048576, refill_time: 100 } }
    await client.putDrive('data', { path_on_host: '/vm/data.ext4', is_root_device: false, rate_limiter })
    assert.deepEqual(server.requests[0].body.rate_limiter, rate_limiter)
  })

  it('putDrive requires an id', async () => {
    await assert.rejects(() => client.putDrive(undefined, {}), /drive id is required/)
  })

  it('putNetworkInterface sends PUT /network-interfaces/{id}', async () => {
    await client.putNetworkInterface('eth0', { host_dev_name: 'tap0', guest_mac: 'AA:BB:CC:DD:EE:FF' })
    assert.equal(server.requests[0].path, '/network-interfaces/eth0')
    assert.deepEqual(server.requests[0].body, { iface_id: 'eth0', host_dev_name: 'tap0', guest_mac: 'AA:BB:CC:DD:EE:FF' })
  })

  it('putVsock sends PUT /vsock', async () => {
    await client.putVsock({ guest_cid: 3, uds_path: '/vm/v.sock' })
    assert.equal(server.requests[0].path, '/vsock')
    assert.deepEqual(server.requests[0].body, { guest_cid: 3, uds_path: '/vm/v.sock' })
  })

  it('start sends PUT /actions {action_type: InstanceStart}', async () => {
    await client.start()
    assert.equal(server.requests[0].path, '/actions')
    assert.deepEqual(server.requests[0].body, { action_type: 'InstanceStart' })
  })

  it('sendCtrlAltDel sends PUT /actions {action_type: SendCtrlAltDel}', async () => {
    await client.sendCtrlAltDel()
    assert.deepEqual(server.requests[0].body, { action_type: 'SendCtrlAltDel' })
  })

  it('pause sends PATCH /vm {state: Paused}', async () => {
    await client.pause()
    assert.equal(server.requests[0].method, 'PATCH')
    assert.equal(server.requests[0].path, '/vm')
    assert.deepEqual(server.requests[0].body, { state: 'Paused' })
  })

  it('resume sends PATCH /vm {state: Resumed}', async () => {
    await client.resume()
    assert.deepEqual(server.requests[0].body, { state: 'Resumed' })
  })

  it('createSnapshot sends PUT /snapshot/create', async () => {
    await client.createSnapshot({ snapshot_path: '/vm/snap.vmstate', mem_file_path: '/vm/snap.mem', snapshot_type: 'Full' })
    assert.equal(server.requests[0].path, '/snapshot/create')
    assert.deepEqual(server.requests[0].body, {
      snapshot_path: '/vm/snap.vmstate', mem_file_path: '/vm/snap.mem', snapshot_type: 'Full',
    })
  })

  it('loadSnapshot sends PUT /snapshot/load with mem_backend', async () => {
    await client.loadSnapshot({
      snapshot_path: '/vm/snap.vmstate',
      mem_backend: { backend_type: 'File', backend_path: '/vm/snap.mem' },
      resume_vm: true,
    })
    assert.equal(server.requests[0].path, '/snapshot/load')
    assert.deepEqual(server.requests[0].body, {
      snapshot_path: '/vm/snap.vmstate',
      mem_backend: { backend_type: 'File', backend_path: '/vm/snap.mem' },
      resume_vm: true,
    })
  })

  it('getInstanceInfo sends GET /', async () => {
    const info = await client.getInstanceInfo()
    assert.equal(server.requests[0].path, '/')
    assert.equal(info.app_name, 'Firecracker')
  })

  it('patchBalloon sends PATCH /balloon', async () => {
    await client.patchBalloon({ amount_mib: 64 })
    assert.equal(server.requests[0].method, 'PATCH')
    assert.deepEqual(server.requests[0].body, { amount_mib: 64 })
  })

  it('getBalloon sends GET /balloon', async () => {
    const balloon = await client.getBalloon()
    assert.equal(balloon.amount_mib, 0)
  })

  it('throws FirecrackerApiError with status + fault_message on 400', async () => {
    server.failNext('boot-source cannot be updated post boot')
    await assert.rejects(
      () => client.putBootSource({ kernel_image_path: '/boot/vmlinux' }),
      (err) => {
        assert.ok(err instanceof FirecrackerApiError)
        assert.equal(err.status, 400)
        assert.equal(err.faultMessage, 'boot-source cannot be updated post boot')
        assert.equal(err.method, 'PUT')
        assert.equal(err.path, '/boot-source')
        return true
      },
    )
  })
})
