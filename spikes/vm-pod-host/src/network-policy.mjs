/**
 * network-policy.mjs — host-side network setup for one microVM pod, as
 * plain argv arrays. Pure: nothing here runs a command; `VmPod` hands the
 * arrays to its injectable `exec()` (or records them when `dryRun`).
 *
 * What the plan establishes for ONE pod (a TAP device with a /30 to itself):
 *
 *   - the guest can only send packets sourced from its own IP and MAC;
 *   - the guest cannot reach any service on the host itself (input is
 *     dropped for the TAP), and cannot use IPv6;
 *   - forwarded traffic goes only to the operator's `egress` policy:
 *     by default public addresses only (private, loopback, link-local,
 *     carrier-grade NAT, multicast and reserved ranges are dropped, which
 *     includes the cloud metadata address and the host's LAN);
 *   - nothing from other TAPs or the uplink reaches the guest except replies
 *     to what it opened.
 *
 * Every rule lives in a table of its own (`fc-<id>`), so teardown is a
 * single `nft delete table` that cannot touch another pod's rules, and a
 * pod's rules never match another pod's TAP.
 *
 * NOT RUN against a real host: these are argv arrays checked in unit tests
 * for the nft grammar they emit; they have not been applied to a kernel.
 * Every interpolated value is validated against a strict pattern first,
 * because the values end up inside nft's own grammar.
 */

import { createHash } from 'node:crypto'

/** Destinations a guest may never reach by default. */
export const DEFAULT_DENIED_CIDRS = Object.freeze([
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '224.0.0.0/4',
  '240.0.0.0/4',
])

const POOL_FIRST_OCTETS = '10.200'
/** /30 blocks available in 10.200.0.0/16. */
const POOL_SIZE = 65536 / 4

const ID_PATTERN = /^[0-9A-Za-z-]{1,64}$/
const IFACE_PATTERN = /^[A-Za-z0-9_.-]{1,15}$/
const IPV4_PATTERN = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const CIDR_PATTERN = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\/(3[0-2]|[12]?\d)$/
const MAC_PATTERN = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/
const EGRESS_MODES = Object.freeze(['public', 'allowlist', 'none'])

/**
 * A TAP device name for a pod name. Linux interface names are at most 15
 * characters and pod names may be 64, so a prefix would both fail and
 * collide; this is `tap-` plus 10 hex characters of the name's SHA-256.
 *
 * @param {string} name
 * @returns {string}
 */
export function tapDeviceName(name) {
  return `tap-${createHash('sha256').update(String(name)).digest('hex').slice(0, 10)}`
}

/**
 * The `index`th /30 of 10.200.0.0/16: host on .1, guest on .2.
 *
 * @param {number} index
 * @returns {{hostIp: string, guestIp: string, netmask: string, cidr: string}}
 */
export function allocateSubnet(index) {
  if (!Number.isInteger(index) || index < 0) throw new Error('allocateSubnet: index must be a non-negative integer')
  if (index >= POOL_SIZE) throw new Error('allocateSubnet: pool exhausted')
  const offset = index * 4
  const third = Math.floor(offset / 256)
  const fourth = offset % 256
  const base = `${POOL_FIRST_OCTETS}.${third}`
  return {
    hostIp: `${base}.${fourth + 1}`,
    guestIp: `${base}.${fourth + 2}`,
    netmask: '255.255.255.252',
    cidr: `${base}.${fourth}/30`,
  }
}

/**
 * @param {*} value
 * @param {RegExp} pattern
 * @param {string} label
 * @returns {string}
 */
function check(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`buildNetworkPlan: ${label} is missing or malformed`)
  }
  return value
}

/**
 * @typedef {object} NetworkPlanOptions
 * @property {string} id - Pod / VM id; names the nft table `fc-<id>`.
 * @property {string} tapDev - TAP device name (see {@link tapDeviceName}).
 * @property {string} hostIp - Address the host holds on the TAP (the guest's gateway).
 * @property {string} guestIp - The only source address the guest may use.
 * @property {string} [guestMac] - The only source MAC the guest may use.
 * @property {string} [uplink='eth0'] - Interface traffic leaves through.
 * @property {{mode?: 'public'|'allowlist'|'none', allowCidrs?: string[]}} [egress]
 *   `public` (default): everything except {@link DEFAULT_DENIED_CIDRS}, plus
 *   `allowCidrs` ahead of the denials. `allowlist`: only `allowCidrs`.
 *   `none`: no forwarding at all.
 */

/**
 * @param {NetworkPlanOptions} opts
 * @returns {{setup: string[][], teardown: string[][], table: string}}
 */
export function buildNetworkPlan(opts = {}) {
  const id = check(opts.id, ID_PATTERN, 'id')
  const tapDev = check(opts.tapDev, IFACE_PATTERN, 'tapDev')
  const uplink = check(opts.uplink ?? 'eth0', IFACE_PATTERN, 'uplink')
  const hostIp = check(opts.hostIp, IPV4_PATTERN, 'hostIp')
  const guestIp = check(opts.guestIp, IPV4_PATTERN, 'guestIp')
  const guestMac = opts.guestMac === undefined ? null : check(opts.guestMac, MAC_PATTERN, 'guestMac')

  const mode = opts.egress?.mode ?? 'public'
  if (!EGRESS_MODES.includes(mode)) {
    throw new Error(`buildNetworkPlan: egress.mode must be one of ${EGRESS_MODES.join('|')}`)
  }
  const allowCidrs = (opts.egress?.allowCidrs ?? []).map((cidr) => check(cidr, CIDR_PATTERN, 'egress.allowCidrs entry'))
  if (opts.egress?.allowCidrs !== undefined && !Array.isArray(opts.egress.allowCidrs)) {
    throw new Error('buildNetworkPlan: egress.allowCidrs must be an array')
  }

  const table = `fc-${id}`
  const tap = `"${tapDev}"`
  const out = `"${uplink}"`
  /** @param {string[]} cidrs */
  const set = (cidrs) => `{ ${cidrs.join(', ')} }`
  /** @type {string[][]} */
  const setup = []
  /** @param {string} chain @param {string} rule */
  const rule = (chain, text) => setup.push(['nft', 'add', 'rule', 'inet', table, chain, text])

  setup.push(['ip', 'tuntap', 'add', tapDev, 'mode', 'tap'])
  setup.push(['ip', 'addr', 'add', `${hostIp}/30`, 'dev', tapDev])
  setup.push(['ip', 'link', 'set', tapDev, 'up'])

  setup.push(['nft', 'add', 'table', 'inet', table])
  setup.push(['nft', 'add', 'chain', 'inet', table, 'input', '{ type filter hook input priority 0 ; policy accept ; }'])
  setup.push(['nft', 'add', 'chain', 'inet', table, 'forward', '{ type filter hook forward priority 0 ; policy accept ; }'])

  // The guest talks to nothing on the host itself.
  rule('input', `iifname ${tap} drop`)

  // Only the guest's own addresses may leave the TAP; no IPv6.
  rule('forward', `iifname ${tap} meta nfproto ipv6 drop`)
  rule('forward', `iifname ${tap} ip saddr != ${guestIp} drop`)
  if (guestMac) rule('forward', `iifname ${tap} ether saddr != ${guestMac} drop`)

  // Egress. The operator's destinations come first so they can punch a
  // hole through a denied range (a signaling server on a private network).
  if (mode !== 'none') {
    for (const cidr of allowCidrs) rule('forward', `iifname ${tap} ip daddr ${cidr} oifname ${out} accept`)
    if (mode === 'public') {
      rule('forward', `iifname ${tap} ip daddr ${set(DEFAULT_DENIED_CIDRS)} drop`)
      rule('forward', `iifname ${tap} oifname ${out} accept`)
    }
  }
  // Whatever is left from this TAP is not allowed.
  rule('forward', `iifname ${tap} drop`)

  // Into the guest: replies only.
  rule('forward', `oifname ${tap} ct state established,related accept`)
  rule('forward', `oifname ${tap} drop`)

  if (mode !== 'none') {
    setup.push(['nft', 'add', 'chain', 'inet', table, 'postrouting', '{ type nat hook postrouting priority 100 ; policy accept ; }'])
    rule('postrouting', `ip saddr ${guestIp} oifname ${out} masquerade`)
  }

  const teardown = [
    ['nft', 'delete', 'table', 'inet', table],
    ['ip', 'link', 'set', tapDev, 'down'],
    ['ip', 'tuntap', 'del', tapDev, 'mode', 'tap'],
  ]
  return { setup, teardown, table }
}
