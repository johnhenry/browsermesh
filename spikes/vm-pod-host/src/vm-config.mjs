/**
 * vm-config.mjs -- the pure configuration a jailed Firecracker microVM needs
 * beyond the API calls themselves: the guest kernel command line, the cgroup
 * limits for the VMM process, and the layout of the jail's chroot (where
 * each file lives as Firecracker sees it, and as the host sees it) with the
 * commands that put files there.
 *
 * Nothing here runs anything. `VmPod` applies it. NOT VERIFIED on a real
 * host: the argument shapes follow the Firecracker and jailer documentation,
 * and `npm run test:real-firecracker` (a Linux/KVM host) is what checks them.
 */

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
// ws:// or wss://, a host, an optional port and an optional plain path: no
// credentials, no query string, nothing that is not URL-safe and space-free.
const SIGNALING_URL = /^wss?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/

/**
 * The guest kernel command line, in the contract `guest/init` reads back
 * from `/proc/cmdline`. Every interpolated value is validated, because
 * anything with a space in it would add a kernel parameter (`init=`...), and
 * the whole line is readable through the Firecracker API: no secret goes in.
 *
 * @param {object} opts
 * @param {string} opts.guestIp
 * @param {string} opts.gatewayIp
 * @param {string} opts.netmask
 * @param {string} [opts.signalingUrl]
 * @returns {string}
 */
export function buildBootArgs({ guestIp, gatewayIp, netmask, signalingUrl } = {}) {
  if (!IPV4.test(guestIp ?? '')) throw new Error('buildBootArgs: guestIp is missing or malformed')
  if (!IPV4.test(gatewayIp ?? '')) throw new Error('buildBootArgs: gatewayIp is missing or malformed')
  if (!IPV4.test(netmask ?? '')) throw new Error('buildBootArgs: netmask is missing or malformed')
  if (signalingUrl !== undefined && !SIGNALING_URL.test(signalingUrl)) {
    throw new Error('buildBootArgs: signalingUrl must be ws:// or wss:// host[:port][/path], with no credentials or query')
  }
  return [
    'console=ttyS0', 'reboot=k', 'panic=1', 'pci=off',
    'root=/dev/vda', 'rw', 'init=/init',
    `ip=${guestIp}::${gatewayIp}:${netmask}::eth0:off`,
    ...(signalingUrl === undefined ? [] : [`signaling_url=${signalingUrl}`]),
  ].join(' ')
}

/**
 * `jailer --cgroup` settings (cgroup v2 files) bounding the VMM process: CPU
 * time for the vcpus, memory for the guest plus the VMM's own overhead, and
 * a thread count. The numbers are a starting point, not measured.
 *
 * @param {{vcpus: number, memMib: number, overheadMib?: number}} opts
 * @returns {string[]}
 */
export function cgroupsFor({ vcpus, memMib, overheadMib = 64 } = {}) {
  if (!Number.isInteger(vcpus) || vcpus < 1) throw new Error('cgroupsFor: vcpus must be a positive integer')
  if (!Number.isInteger(memMib) || memMib < 1) throw new Error('cgroupsFor: memMib must be a positive integer')
  if (!Number.isInteger(overheadMib) || overheadMib < 0) throw new Error('cgroupsFor: overheadMib must be a non-negative integer')
  return [
    `cpu.max=${vcpus * 100_000} 100000`,
    `memory.max=${(memMib + overheadMib) * 1024 * 1024}`,
    // Firecracker runs an API thread, a VMM thread and one thread per vcpu.
    `pids.max=${vcpus + 32}`,
  ]
}

/**
 * Where each file lives for a jailed VM. Inside the jail Firecracker's
 * filesystem root is the chroot, so the API is given names relative to it;
 * the host reaches the same files under the chroot's `root` directory.
 *
 * @param {{root: string}} opts - The jail's `root` directory on the host
 *   (`<chroot base>/<exec file name>/<id>/root`).
 * @returns {{api: Record<string, string>, host: Record<string, string>}}
 */
export function chrootLayout({ root } = {}) {
  if (typeof root !== 'string' || !root.startsWith('/')) throw new Error('chrootLayout: root must be an absolute path')
  const dir = root.replace(/\/+$/, '')
  const api = { kernel: 'vmlinux', rootfs: 'rootfs.ext4', vsock: 'v.sock', vmstate: 'vmstate', mem: 'mem' }
  const host = Object.fromEntries(Object.entries(api).map(([key, name]) => [key, `${dir}/${name}`]))
  return { api, host }
}

/**
 * Commands that put the kernel and a private rootfs copy inside the jail,
 * owned by the VMM's unprivileged identity. The jailer does not do this: it
 * builds the chroot and starts the VMM, and the caller supplies the files.
 * The kernel is read-only to the VMM; the rootfs is its own copy, never the
 * shared base image.
 *
 * @param {{root: string, kernelSrc: string, rootfsSrc: string, uid: number, gid: number}} opts
 * @returns {string[][]}
 */
export function planChrootStaging({ root, kernelSrc, rootfsSrc, uid, gid } = {}) {
  const { host } = chrootLayout({ root })
  if (typeof kernelSrc !== 'string' || !kernelSrc.startsWith('/')) throw new Error('planChrootStaging: kernelSrc must be an absolute path')
  if (typeof rootfsSrc !== 'string' || !rootfsSrc.startsWith('/')) throw new Error('planChrootStaging: rootfsSrc must be an absolute path')
  if (!Number.isInteger(uid) || uid <= 0) throw new Error('planChrootStaging: uid must be a non-zero integer')
  if (!Number.isInteger(gid) || gid <= 0) throw new Error('planChrootStaging: gid must be a non-zero integer')
  return [
    ['cp', '--reflink=auto', '--no-clobber', '--', kernelSrc, host.kernel],
    ['cp', '--reflink=auto', '--no-clobber', '--', rootfsSrc, host.rootfs],
    ['chown', `${uid}:${gid}`, '--', host.kernel, host.rootfs],
    ['chmod', '0400', '--', host.kernel],
    ['chmod', '0600', '--', host.rootfs],
  ]
}
