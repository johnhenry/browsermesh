import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildBootArgs,
  cgroupsFor,
  chrootLayout,
  planChrootStaging,
} from '../src/vm-config.mjs'

describe('buildBootArgs', () => {
  const base = { guestIp: '10.200.0.2', gatewayIp: '10.200.0.1', netmask: '255.255.255.252', signalingUrl: 'wss://signal.example.com/ws' }

  it('is the kernel command line guest/init reads: root, init, ip= and signaling_url=', () => {
    assert.equal(
      buildBootArgs(base),
      'console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw init=/init '
      + 'ip=10.200.0.2::10.200.0.1:255.255.255.252::eth0:off signaling_url=wss://signal.example.com/ws',
    )
  })

  it('leaves signaling_url out when none is configured (the pod then registers with nothing)', () => {
    assert.doesNotMatch(buildBootArgs({ ...base, signalingUrl: undefined }), /signaling_url/)
  })

  it('refuses anything that could add a kernel parameter of its own', () => {
    for (const signalingUrl of ['wss://a.example.com init=/bin/sh', 'wss://a.example.com\ninit=/bin/sh', 'ws://x"y', 'http://not-a-websocket', 'wss://']) {
      assert.throws(() => buildBootArgs({ ...base, signalingUrl }), /signalingUrl/, signalingUrl)
    }
    assert.throws(() => buildBootArgs({ ...base, guestIp: '10.0.0.2 init=/bin/sh' }), /guestIp/)
    assert.throws(() => buildBootArgs({ ...base, netmask: 'x' }), /netmask/)
  })

  it('carries no secret: the boot arguments are readable through the Firecracker API', () => {
    // The only values that reach the command line are an address triple and a URL.
    assert.throws(() => buildBootArgs({ ...base, signalingUrl: 'wss://user:token@signal.example.com/ws' }), /signalingUrl/)
    assert.throws(() => buildBootArgs({ ...base, signalingUrl: 'wss://signal.example.com/ws?token=abc' }), /signalingUrl/)
  })
})

describe('cgroupsFor', () => {
  it('limits the VMM process to the pod\'s vcpus, its memory plus VMM overhead, and a thread count', () => {
    assert.deepEqual(cgroupsFor({ vcpus: 2, memMib: 256 }), [
      'cpu.max=200000 100000',
      `memory.max=${(256 + 64) * 1024 * 1024}`,
      'pids.max=34',
    ])
  })

  it('takes the overhead from the caller', () => {
    assert.ok(cgroupsFor({ vcpus: 1, memMib: 128, overheadMib: 32 }).includes(`memory.max=${160 * 1024 * 1024}`))
  })

  it('rejects limits that are not positive integers', () => {
    assert.throws(() => cgroupsFor({ vcpus: 0, memMib: 128 }), /vcpus/)
    assert.throws(() => cgroupsFor({ vcpus: 1, memMib: 1.5 }), /memMib/)
  })
})

describe('chrootLayout', () => {
  const layout = chrootLayout({ root: '/srv/jailer/firecracker/demo/root' })

  it('names every file by the path Firecracker sees from inside the jail', () => {
    assert.deepEqual(layout.api, {
      kernel: 'vmlinux', rootfs: 'rootfs.ext4', vsock: 'v.sock', vmstate: 'vmstate', mem: 'mem',
    })
  })

  it('and by the path the host sees outside it', () => {
    assert.deepEqual(layout.host, {
      kernel: '/srv/jailer/firecracker/demo/root/vmlinux',
      rootfs: '/srv/jailer/firecracker/demo/root/rootfs.ext4',
      vsock: '/srv/jailer/firecracker/demo/root/v.sock',
      vmstate: '/srv/jailer/firecracker/demo/root/vmstate',
      mem: '/srv/jailer/firecracker/demo/root/mem',
    })
  })

  it('needs an absolute root', () => {
    assert.throws(() => chrootLayout({ root: 'relative/root' }), /absolute/)
  })
})

describe('planChrootStaging', () => {
  const plan = planChrootStaging({
    root: '/srv/jailer/firecracker/demo/root',
    kernelSrc: '/boot/vmlinux',
    rootfsSrc: '/vm/base/alpine.ext4',
    uid: 100003,
    gid: 100003,
  })

  it('puts the kernel and a private copy of the rootfs inside the jail, owned by the VMM\'s identity', () => {
    assert.deepEqual(plan, [
      ['cp', '--reflink=auto', '--no-clobber', '--', '/boot/vmlinux', '/srv/jailer/firecracker/demo/root/vmlinux'],
      ['cp', '--reflink=auto', '--no-clobber', '--', '/vm/base/alpine.ext4', '/srv/jailer/firecracker/demo/root/rootfs.ext4'],
      ['chown', '100003:100003', '--', '/srv/jailer/firecracker/demo/root/vmlinux', '/srv/jailer/firecracker/demo/root/rootfs.ext4'],
      ['chmod', '0400', '--', '/srv/jailer/firecracker/demo/root/vmlinux'],
      ['chmod', '0600', '--', '/srv/jailer/firecracker/demo/root/rootfs.ext4'],
    ])
  })

  it('refuses the root identity, and paths that are not absolute', () => {
    assert.throws(() => planChrootStaging({ root: '/r', kernelSrc: '/k', rootfsSrc: '/f', uid: 0, gid: 1 }), /uid/)
    assert.throws(() => planChrootStaging({ root: '/r', kernelSrc: 'k', rootfsSrc: '/f', uid: 1, gid: 1 }), /kernelSrc/)
    assert.throws(() => planChrootStaging({ root: '/r', kernelSrc: '/k', rootfsSrc: 'f', uid: 1, gid: 1 }), /rootfsSrc/)
  })
})
