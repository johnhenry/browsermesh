import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  tapDeviceName,
  allocateSubnet,
  buildNetworkPlan,
  DEFAULT_DENIED_CIDRS,
} from '../src/network-policy.mjs'

const BASE = {
  id: 'demo',
  tapDev: 'tap-0123456789',
  hostIp: '10.200.0.1',
  guestIp: '10.200.0.2',
  guestMac: 'AA:BB:CC:DD:EE:01',
  uplink: 'eth0',
}

/** Every argv a plan would run, flattened to one line each so assertions read like the nft CLI. */
function lines(plan) {
  return plan.setup.map((argv) => argv.join(' '))
}

describe('tapDeviceName', () => {
  it('fits the 15 character interface-name limit for the longest pod name', () => {
    const name = tapDeviceName('a'.repeat(64))
    assert.ok(name.length <= 15, `${name} is ${name.length} chars`)
    assert.match(name, /^tap-[0-9a-f]+$/)
  })

  it('is stable and distinguishes names that share a long prefix', () => {
    const a = 'pod-with-a-long-common-prefix-1'
    const b = 'pod-with-a-long-common-prefix-2'
    assert.equal(tapDeviceName(a), tapDeviceName(a))
    assert.notEqual(tapDeviceName(a), tapDeviceName(b))
  })
})

describe('allocateSubnet', () => {
  it('hands out distinct /30s with the host on .1 and the guest on .2 of each', () => {
    const first = allocateSubnet(0)
    const second = allocateSubnet(1)
    assert.deepEqual(first, { hostIp: '10.200.0.1', guestIp: '10.200.0.2', netmask: '255.255.255.252', cidr: '10.200.0.0/30' })
    assert.deepEqual(second, { hostIp: '10.200.0.5', guestIp: '10.200.0.6', netmask: '255.255.255.252', cidr: '10.200.0.4/30' })
  })

  it('rolls into the next octet and refuses an index past the pool', () => {
    assert.equal(allocateSubnet(64).hostIp, '10.200.1.1')
    assert.throws(() => allocateSubnet(-1), /index/)
    assert.throws(() => allocateSubnet(65536 / 4 * 4), /pool/)
  })
})

describe('buildNetworkPlan', () => {
  it('creates a per-pod table so teardown is one command and cannot touch another pod', () => {
    const plan = buildNetworkPlan(BASE)
    assert.equal(plan.setup[0].join(' '), 'ip tuntap add tap-0123456789 mode tap')
    assert.ok(lines(plan).some((l) => l === 'nft add table inet fc-demo'))
    assert.deepEqual(plan.teardown.at(-1), ['ip', 'tuntap', 'del', 'tap-0123456789', 'mode', 'tap'])
    assert.ok(plan.teardown.some((argv) => argv.join(' ') === 'nft delete table inet fc-demo'))
    // Nothing may be added to a table shared between pods.
    for (const argv of plan.setup.filter((a) => a[0] === 'nft')) {
      assert.ok(argv.includes('fc-demo') || argv.includes('ip'), `shared table touched: ${argv.join(' ')}`)
    }
  })

  it('addresses the TAP so the guest has a gateway on the host side', () => {
    const plan = buildNetworkPlan(BASE)
    assert.ok(lines(plan).includes('ip addr add 10.200.0.1/30 dev tap-0123456789'))
    assert.ok(lines(plan).includes('ip link set tap-0123456789 up'))
  })

  it('drops everything the guest sends to the host itself', () => {
    const text = lines(buildNetworkPlan(BASE)).join('\n')
    assert.match(text, /input.*hook input/)
    assert.match(text, /iifname "tap-0123456789" drop/)
  })

  it('drops source-spoofed traffic and anything IPv6', () => {
    const text = lines(buildNetworkPlan(BASE)).join('\n')
    assert.match(text, /iifname "tap-0123456789" ip saddr != 10\.200\.0\.2 drop/)
    assert.match(text, /iifname "tap-0123456789" ether saddr != AA:BB:CC:DD:EE:01 drop/)
    assert.match(text, /iifname "tap-0123456789" meta nfproto ipv6 drop/)
  })

  it('by default only forwards to public addresses', () => {
    const text = lines(buildNetworkPlan(BASE)).join('\n')
    for (const cidr of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '127.0.0.0/8', '100.64.0.0/10']) {
      assert.ok(text.includes(cidr), `${cidr} must be denied`)
    }
    assert.match(text, /iifname "tap-0123456789" ip daddr \{[^}]*169\.254\.0\.0\/16[^}]*\} drop/)
    assert.match(text, /iifname "tap-0123456789" oifname "eth0" accept/)
    assert.ok(DEFAULT_DENIED_CIDRS.includes('169.254.0.0/16'))
  })

  it('allows an operator-listed destination ahead of the private-range denial', () => {
    const plan = buildNetworkPlan({ ...BASE, egress: { allowCidrs: ['10.9.0.5/32'] } })
    const rules = lines(plan)
    const allowAt = rules.findIndex((l) => l.includes('10.9.0.5/32') && l.endsWith('accept'))
    const denyAt = rules.findIndex((l) => l.includes('169.254.0.0/16') && l.endsWith('drop'))
    assert.ok(allowAt >= 0 && denyAt >= 0)
    assert.ok(allowAt < denyAt, 'the allowlist entry must come first')
  })

  it("mode 'allowlist' forwards only to the listed destinations", () => {
    const plan = buildNetworkPlan({ ...BASE, egress: { mode: 'allowlist', allowCidrs: ['203.0.113.0/24'] } })
    const text = lines(plan).join('\n')
    assert.match(text, /ip daddr 203\.0\.113\.0\/24 oifname "eth0" accept/)
    assert.doesNotMatch(text, /iifname "tap-0123456789" oifname "eth0" accept/)
  })

  it("mode 'none' installs no forwarding to the uplink and no masquerade", () => {
    const text = lines(buildNetworkPlan({ ...BASE, egress: { mode: 'none' } })).join('\n')
    assert.doesNotMatch(text, /oifname "eth0" accept/)
    assert.doesNotMatch(text, /masquerade/)
    assert.match(text, /iifname "tap-0123456789" drop/)
  })

  it('refuses values that would change the nft grammar', () => {
    assert.throws(() => buildNetworkPlan({ ...BASE, id: 'x; flush ruleset' }), /id/)
    assert.throws(() => buildNetworkPlan({ ...BASE, tapDev: 'tap0"; drop' }), /tapDev/)
    assert.throws(() => buildNetworkPlan({ ...BASE, uplink: 'eth0 accept' }), /uplink/)
    assert.throws(() => buildNetworkPlan({ ...BASE, guestIp: '10.200.0.2 }' }), /guestIp/)
    assert.throws(() => buildNetworkPlan({ ...BASE, guestMac: 'zz' }), /guestMac/)
    assert.throws(() => buildNetworkPlan({ ...BASE, egress: { allowCidrs: ['10.0.0.0/8 }; flush ruleset'] } }), /allowCidrs/)
    assert.throws(() => buildNetworkPlan({ ...BASE, egress: { mode: 'open' } }), /mode/)
  })
})
