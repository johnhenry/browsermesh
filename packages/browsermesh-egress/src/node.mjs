/**
 * node.mjs -- the Node half: `nodeDialer`, the provider's `dial` and `resolve` on wsh's address guard. The only entry of
 * this package that imports `node:` modules or wsh.
 *
 * Every decision about an address goes through `@johnhenry/wsh/address-guard` (`resolveChecked`, `dialChecked`,
 * `isPublicAddress`): this file classifies nothing. A name is resolved ONCE, every answer is classified, and the connection
 * is made to an address that passed, never to the name again.
 *
 *   import { createMeshEgress } from '@johnhenry/browsermesh-egress'
 *   import { nodeDialer } from '@johnhenry/browsermesh-egress/node'
 *   const egress = createMeshEgress({ service, registry, ...nodeDialer({ allowPrivate: [] }), sets, unattended: true })
 *   egress.start()
 */
import os from 'node:os'

let guard
try { guard = await import('@johnhenry/wsh/address-guard') } catch (cause) {
  throw new Error(`@johnhenry/browsermesh-egress/node needs @johnhenry/wsh 0.55.0 or later (its address guard): ${cause?.message ?? cause}`, { cause })
}
const { dialChecked, dialUdpChecked, resolveChecked, isPublicAddress, checkAddress } = guard

import { createExchange } from './node-exchange.mjs'

export { createMeshEgress, DEFAULT_BLOCKED_PORTS, DEFAULT_BLOCKED_UDP_PORTS, WIDE_ACKNOWLEDGEMENT } from './provider.mjs'
export { createExchange, nodeExchange } from './node-exchange.mjs'

/** The public addresses of this machine's own interfaces: a name that resolves to one is the provider itself. */
function ownPublicAddresses() {
  const out = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a?.address && isPublicAddress(a.address.split('%')[0])) out.push(a.address.split('%')[0])
  }
  return out
}

/**
 * @param {object} [opts]
 * @param {string[]} [opts.allowPrivate=[]] - CIDR blocks or addresses of PRIVATE space a destination the operator granted may resolve
 *   to (`'10.0.0.0/8'`, `'127.0.0.1'`). Nothing else makes private, loopback, link-local, unique-local, carrier-NAT or metadata
 *   space reachable, and a peer's grant never does. A destination admitted by a wildcard grant (wide mode) ignores this.
 * @param {string[]} [opts.deny=[]] - CIDR blocks or addresses always refused, public ones included; wins over `allowPrivate`
 * @param {boolean} [opts.denyOwnAddresses=true] - also refuse the public addresses of this machine's own interfaces
 * @param {boolean} [opts.refuseMixed=true] - refuse a name when ANY of its answers is refused (wsh's default drops the refused ones and
 *   connects to the rest; here a name that answers with both a public and a private address is refused whole, because a name that
 *   mixes them is not one the operator can vouch for)
 * @param {(name: string, options: { family: number }) => Promise<Array<string|{ address: string }>>} [opts.lookup] - the resolver (default: the system's); tests replace it
 * @param {string|Buffer|Array<string|Buffer>} [opts.ca] - certificate authorities trusted for the fetch form's `https:` instead of Node's own list
 * @returns {{ dial: Function, dialUdp: Function, resolve: Function, exchange: Function }} the options `createMeshEgress` takes (`exchange` is the fetch form's HTTP client over `dial`; `dialUdp` is the UDP form's)
 */
export function nodeDialer({ allowPrivate = [], deny = [], denyOwnAddresses = true, refuseMixed = true, lookup, ca } = {}) {
  for (const [name, list] of Object.entries({ allowPrivate, deny })) {
    if (!Array.isArray(list) || !list.every((s) => typeof s === 'string')) throw new TypeError(`nodeDialer: ${name} is a list of CIDR blocks or addresses (strings); \`true\` is not accepted, name the space you mean`)
    for (const entry of list) checkAddress('203.0.113.1', { [name === 'deny' ? 'deny' : 'allow']: [entry] }) // a bad entry throws now, not at the first dial
  }
  const policy = (wide) => ({
    allow: wide ? [] : allowPrivate,
    allowPrivate: false,
    deny: denyOwnAddresses ? [...deny, ...ownPublicAddresses()] : deny,
    refuseMixed,
    lookup,
  })
  return {
    async dial({ host, port, wide = false, signal, timeoutMs }) {
      const result = await dialChecked(host, port, { ...policy(wide), timeoutMs, signal })
      // A destination that finished sending still accepts what the consumer has yet to send: half-close, not close.
      result.socket.allowHalfOpen = true
      return result
    },
    /** The UDP form's seam: a datagram socket `connect()`ed to the address that was checked (the kernel drops every datagram from any other source). */
    async dialUdp({ host, port, wide = false, signal, timeoutMs }) {
      return dialUdpChecked(host, port, { ...policy(wide), timeoutMs, signal })
    },
    async resolve({ name, wide = false, signal, timeoutMs }) {
      return resolveChecked(name, { ...policy(wide), family: 4, timeoutMs, signal })
    },
    exchange: createExchange({ ca }),
  }
}
