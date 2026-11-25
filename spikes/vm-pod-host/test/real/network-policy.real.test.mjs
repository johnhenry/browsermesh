// The microVM lane's network policy (src/network-policy.mjs), applied to a REAL
// Linux kernel: the same `ip` and `nft` commands VmPod runs, then packets sent
// from a "guest" network namespace to see what the rules let through.
//
// Opt-in: `npm run test:real-linux-network` (here or at the repository root).
// It needs Linux, root (CAP_NET_ADMIN and CAP_SYS_ADMIN: network namespaces),
// `ip` and `nft`, and IPv4 forwarding that it may switch on. It needs NO KVM and
// no Firecracker. Without all of that it skips and reports success;
// REQUIRE_REAL_LINUX_NET=1 makes a missing prerequisite fail instead.
//
// Everything is created under the names `fcnp-*` and removed afterwards. It
// changes host-wide state while it runs (forwarding, two namespaces, three
// links, one nft table): run it in a container or a throwaway machine, e.g.
//
//   docker run --rm --cap-add NET_ADMIN --cap-add SYS_ADMIN \
//     --sysctl net.ipv4.ip_forward=1 -v "$PWD":/repo:ro -w /repo <image with node, iproute2, nftables> \
//     node --test spikes/vm-pod-host/test/real/network-policy.real.test.mjs
//
// What is stand-in: the guest's end of the link is a veth pair named like the
// pod's TAP instead of a TAP device (a TAP needs a process holding its file
// descriptor to carry packets; the filter rules match on the interface NAME and
// do not know the difference). The creation of a real TAP and its removal are
// checked separately, below. What it shows: the rules in this repository parse,
// load and drop and accept what the policy says they do, with traffic that is
// actually forwarded by a kernel.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { promisify } from 'node:util'

import { buildNetworkPlan, tapDeviceName, allocateSubnet } from '../../src/network-policy.mjs'

const run = promisify(execFile)
const GUEST_NS = 'fcnp-guest'
const UP_NS = 'fcnp-up'
const UPLINK = 'fcnp-u0'
const UPSTREAM_IP = '192.0.2.2' // documentation range: public as far as the policy is concerned
const METADATA_IP = '169.254.169.254'
const PRIVATE_IP = '10.99.0.1'
const PORT = 8080
const POD = 'np'
const GUEST_MAC = 'AA:BB:CC:DD:EE:07'

/** Run a command, never throwing: `{ code, stdout, stderr }`. */
async function sh(argv) {
  try {
    const { stdout, stderr } = await run(argv[0], argv.slice(1), { maxBuffer: 1 << 20 })
    return { code: 0, stdout, stderr }
  } catch (err) {
    return { code: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? String(err.message) }
  }
}

async function unmetPrerequisite() {
  if (process.platform !== 'linux') return `not Linux (${process.platform})`
  if (typeof process.getuid === 'function' && process.getuid() !== 0) return 'not root'
  for (const tool of ['ip', 'nft']) {
    if ((await sh(['sh', '-c', `command -v ${tool}`])).code !== 0) return `${tool} is not on PATH`
  }
  const probe = await sh(['ip', 'netns', 'add', 'fcnp-probe'])
  if (probe.code !== 0) return `cannot create a network namespace (${probe.stderr.trim()})`
  await sh(['ip', 'netns', 'del', 'fcnp-probe'])
  // Already on (a container started with `--sysctl net.ipv4.ip_forward=1` has /proc/sys read-only), or switchable here.
  if ((await readFile('/proc/sys/net/ipv4/ip_forward', 'utf8')).trim() !== '1') {
    try {
      await writeFile('/proc/sys/net/ipv4/ip_forward', '1')
      await writeFile('/proc/sys/net/ipv4/ip_forward', '0')
    } catch (err) {
      return `IPv4 forwarding is off and cannot be switched on (${err.code})`
    }
  }
  return null
}

const unmet = await unmetPrerequisite()
const required = process.env.REQUIRE_REAL_LINUX_NET === '1'

/** Can the guest namespace open a TCP connection to `ip:PORT` within a short timeout? */
async function reaches(ip, { localAddress } = {}) {
  const script = `
    const s = require('node:net').connect({ host: ${JSON.stringify(ip)}, port: ${PORT}, localAddress: ${JSON.stringify(localAddress)}, timeout: 800 })
    s.on('connect', () => { s.destroy(); process.exit(0) })
    s.on('timeout', () => process.exit(1))
    s.on('error', () => process.exit(1))`
  return (await sh(['ip', 'netns', 'exec', GUEST_NS, process.execPath, '-e', script])).code === 0
}

if (unmet && required) {
  describe('network policy on a real kernel', () => {
    it('has its prerequisites (REQUIRE_REAL_LINUX_NET=1)', () => assert.fail(`REQUIRE_REAL_LINUX_NET=1 but ${unmet}`))
  })
} else if (unmet) {
  describe('network policy on a real kernel', { skip: `skipped: ${unmet} (see the header of this file)` }, () => {
    it('is skipped without a Linux host with root and network namespaces', () => {})
  })
} else {
  describe('network policy on a real kernel', () => {
    const tapDev = tapDeviceName(POD)
    const subnet = allocateSubnet(7)
    const children = []
    let hostListener
    let hostListenerPort
    let originalForward

    const plan = (egress) => buildNetworkPlan({
      id: POD, tapDev, hostIp: subnet.hostIp, guestIp: subnet.guestIp, guestMac: GUEST_MAC, uplink: UPLINK, egress,
    })
    /**
     * Apply a plan's setup the way VmPod does, except the TAP already exists (as a veth), with its address and
     * state set up by `before` so that the control test can run without rules.
     */
    async function apply(egress) {
      for (const argv of plan(egress).setup) {
        if (argv[0] === 'ip') {
          assert.ok(argv[1] === 'tuntap' || argv[1] === 'addr' || argv[1] === 'link', `unexpected ip command ${argv.join(' ')}`)
          continue
        }
        const r = await sh(argv)
        assert.equal(r.code, 0, `${argv.join(' ')} failed: ${r.stderr}`)
      }
    }
    async function teardownRules() {
      await sh(['nft', 'delete', 'table', 'inet', plan().table])
    }

    before(async () => {
      originalForward = (await readFile('/proc/sys/net/ipv4/ip_forward', 'utf8')).trim()
      if (originalForward !== '1') await writeFile('/proc/sys/net/ipv4/ip_forward', '1')
      const steps = [
        ['ip', 'netns', 'add', GUEST_NS],
        ['ip', 'netns', 'add', UP_NS],
        // guest <-> host: the host end carries the pod's TAP name and address
        ['ip', 'link', 'add', tapDev, 'type', 'veth', 'peer', 'name', 'g0', 'netns', GUEST_NS],
        ['ip', 'addr', 'add', `${subnet.hostIp}/30`, 'dev', tapDev],
        ['ip', 'link', 'set', tapDev, 'up'],
        ['ip', 'netns', 'exec', GUEST_NS, 'ip', 'link', 'set', 'g0', 'name', 'eth0'],
        ['ip', 'netns', 'exec', GUEST_NS, 'ip', 'link', 'set', 'eth0', 'address', GUEST_MAC],
        ['ip', 'netns', 'exec', GUEST_NS, 'ip', 'addr', 'add', `${subnet.guestIp}/30`, 'dev', 'eth0'],
        ['ip', 'netns', 'exec', GUEST_NS, 'ip', 'link', 'set', 'eth0', 'up'],
        ['ip', 'netns', 'exec', GUEST_NS, 'ip', 'link', 'set', 'lo', 'up'],
        ['ip', 'netns', 'exec', GUEST_NS, 'ip', 'route', 'add', 'default', 'via', subnet.hostIp],
        // host <-> upstream: the uplink, with the "internet" behind it
        ['ip', 'link', 'add', UPLINK, 'type', 'veth', 'peer', 'name', 'u1', 'netns', UP_NS],
        ['ip', 'addr', 'add', '192.0.2.1/24', 'dev', UPLINK],
        ['ip', 'link', 'set', UPLINK, 'up'],
        ['ip', 'netns', 'exec', UP_NS, 'ip', 'addr', 'add', `${UPSTREAM_IP}/24`, 'dev', 'u1'],
        ['ip', 'netns', 'exec', UP_NS, 'ip', 'link', 'set', 'u1', 'up'],
        ['ip', 'netns', 'exec', UP_NS, 'ip', 'link', 'set', 'lo', 'up'],
        ['ip', 'netns', 'exec', UP_NS, 'ip', 'route', 'add', 'default', 'via', '192.0.2.1'],
        // addresses the policy must keep the guest away from, "behind" the uplink
        ['ip', 'netns', 'exec', UP_NS, 'ip', 'addr', 'add', `${METADATA_IP}/32`, 'dev', 'lo'],
        ['ip', 'netns', 'exec', UP_NS, 'ip', 'addr', 'add', `${PRIVATE_IP}/32`, 'dev', 'lo'],
        ['ip', 'route', 'add', `${METADATA_IP}/32`, 'via', UPSTREAM_IP, 'dev', UPLINK],
        ['ip', 'route', 'add', `${PRIVATE_IP}/32`, 'via', UPSTREAM_IP, 'dev', UPLINK],
      ]
      for (const argv of steps) {
        const r = await sh(argv)
        assert.equal(r.code, 0, `${argv.join(' ')} failed: ${r.stderr}`)
      }
      // A listener behind the uplink on every address, and one on the host itself.
      const server = spawn('ip', ['netns', 'exec', UP_NS, process.execPath, '-e',
        `require('node:net').createServer((s) => { s.on('error', () => {}); s.end('ok') }).listen(${PORT}, '0.0.0.0', () => console.log('ready'))`], { stdio: ['ignore', 'pipe', 'inherit'] })
      children.push(server)
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.stdout.on('data', (c) => { if (String(c).includes('ready')) resolve() })
      })
      hostListener = net.createServer((s) => { s.on('error', () => {}); s.end('host') }).listen(0, '0.0.0.0')
      await new Promise((resolve) => hostListener.once('listening', resolve))
      hostListenerPort = hostListener.address().port
    })

    after(async () => {
      for (const child of children) child.kill()
      hostListener?.close()
      await teardownRules()
      for (const argv of [
        ['ip', 'route', 'del', `${METADATA_IP}/32`], ['ip', 'route', 'del', `${PRIVATE_IP}/32`],
        ['ip', 'link', 'del', tapDev], ['ip', 'link', 'del', UPLINK],
        ['ip', 'netns', 'del', GUEST_NS], ['ip', 'netns', 'del', UP_NS],
      ]) await sh(argv)
      if (originalForward !== undefined && originalForward !== '1') await writeFile('/proc/sys/net/ipv4/ip_forward', originalForward).catch(() => {})
    })

    it('control: with no rules the guest reaches everything, so the topology itself works', async () => {
      // If this fails, something on the host drops forwarded traffic before this test's rules exist. Docker does:
      // it sets the iptables FORWARD policy to DROP. `iptables -P FORWARD ACCEPT` (CI does this) lets the topology work.
      const why = 'no rules of ours are loaded: a default FORWARD DROP on this host (Docker sets one) is the likely cause'
      assert.equal(await reaches(UPSTREAM_IP), true, why)
      assert.equal(await reaches(METADATA_IP), true, why)
      assert.equal(await reaches(PRIVATE_IP), true, why)
    })

    it('the plan loads into the kernel (this is the nft grammar and the order of the commands)', async () => {
      await apply({ mode: 'public' })
      const tables = await sh(['nft', 'list', 'tables'])
      assert.match(tables.stdout, new RegExp(`table inet ${plan().table}`))
    })

    it('default egress: public addresses are reached, through the host', async () => {
      assert.equal(await reaches(UPSTREAM_IP), true)
    })

    it('default egress: the metadata address and a private address are not reached', async () => {
      assert.equal(await reaches(METADATA_IP), false, 'the guest reached the metadata address')
      assert.equal(await reaches(PRIVATE_IP), false, 'the guest reached a private address')
    })

    it('the guest reaches no service on the host itself, on the TAP address', async () => {
      const script = `
        const s = require('node:net').connect({ host: ${JSON.stringify(subnet.hostIp)}, port: ${hostListenerPort}, timeout: 800 })
        s.on('connect', () => process.exit(0)); s.on('timeout', () => process.exit(1)); s.on('error', () => process.exit(1))`
      const r = await sh(['ip', 'netns', 'exec', GUEST_NS, process.execPath, '-e', script])
      assert.notEqual(r.code, 0, 'the guest reached a listener on the host')
    })

    it('a source address that is not the guest\'s own is dropped, even to a public destination', async () => {
      await sh(['ip', 'netns', 'exec', GUEST_NS, 'ip', 'addr', 'add', '10.200.9.9/32', 'dev', 'eth0'])
      assert.equal(await reaches(UPSTREAM_IP, { localAddress: '10.200.9.9' }), false)
      assert.equal(await reaches(UPSTREAM_IP, { localAddress: subnet.guestIp }), true)
    })

    it('a source MAC that is not the guest\'s own is dropped', async () => {
      await sh(['ip', 'netns', 'exec', GUEST_NS, 'ip', 'link', 'set', 'eth0', 'address', 'AA:BB:CC:DD:EE:08'])
      assert.equal(await reaches(UPSTREAM_IP), false)
      await sh(['ip', 'netns', 'exec', GUEST_NS, 'ip', 'link', 'set', 'eth0', 'address', GUEST_MAC])
      assert.equal(await reaches(UPSTREAM_IP), true)
    })

    it('an operator allow-list entry opens a hole through a denied range, and only that one', async () => {
      await teardownRules()
      await apply({ mode: 'public', allowCidrs: [`${PRIVATE_IP}/32`] })
      assert.equal(await reaches(PRIVATE_IP), true)
      assert.equal(await reaches(METADATA_IP), false)
    })

    it('mode allowlist: only the listed destination; mode none: nothing at all', async () => {
      await teardownRules()
      await apply({ mode: 'allowlist', allowCidrs: [`${UPSTREAM_IP}/32`] })
      assert.equal(await reaches(UPSTREAM_IP), true)
      assert.equal(await reaches(PRIVATE_IP), false)
      await teardownRules()
      await apply({ mode: 'none' })
      assert.equal(await reaches(UPSTREAM_IP), false)
    })

    it('teardown removes this pod\'s table and nothing else; with it gone the guest is unfiltered again', async () => {
      await sh(['nft', 'add', 'table', 'inet', 'fcnp-bystander'])
      await teardownRules()
      const tables = await sh(['nft', 'list', 'tables'])
      assert.doesNotMatch(tables.stdout, new RegExp(`table inet ${plan().table}`))
      assert.match(tables.stdout, /fcnp-bystander/)
      await sh(['nft', 'delete', 'table', 'inet', 'fcnp-bystander'])
      assert.equal(await reaches(METADATA_IP), true)
    })

    it('a real TAP device is created and removed by the plan\'s own commands', async (t) => {
      const real = buildNetworkPlan({ id: 'tapcheck', tapDev: tapDeviceName('tapcheck'), hostIp: '10.200.7.1', guestIp: '10.200.7.2', uplink: UPLINK })
      const create = real.setup.find((argv) => argv[1] === 'tuntap')
      const made = await sh(create)
      if (made.code !== 0 && /No such file|open: /.test(made.stderr)) {
        // A container without /dev/net/tun: the check needs the device node, which is a property of the machine, not of the plan.
        t.skip(`no /dev/net/tun here (${made.stderr.trim()})`)
        return
      }
      assert.equal(made.code, 0, made.stderr)
      assert.match((await sh(['ip', 'link', 'show', tapDeviceName('tapcheck')])).stdout, /tap/)
      for (const argv of real.teardown.filter((a) => a[0] === 'ip')) await sh(argv)
      assert.notEqual((await sh(['ip', 'link', 'show', tapDeviceName('tapcheck')])).code, 0)
    })
  })
}
