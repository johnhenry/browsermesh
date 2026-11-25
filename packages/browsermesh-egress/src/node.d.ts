/**
 * @johnhenry/browsermesh-egress/node: the provider's `dial` and `resolve` on wsh's address guard (`@johnhenry/wsh/address-guard`).
 */
import type { DialRequest, DialedSocket, ResolveRequest } from './index.js'

export { createMeshEgress, DEFAULT_BLOCKED_PORTS, WIDE_ACKNOWLEDGEMENT } from './index.js'

export interface NodeDialerOptions {
  /** CIDR blocks or addresses of private space a destination the operator granted may resolve to. Nothing else makes private space reachable, and a peer's grant never does. */
  allowPrivate?: string[]
  /** CIDR blocks or addresses always refused, public ones included; wins over `allowPrivate`. */
  deny?: string[]
  /** Also refuse the public addresses of this machine's own interfaces. Default true. */
  denyOwnAddresses?: boolean
  /** Refuse a name when ANY of its answers is refused (default true; wsh's own default drops the refused answers). */
  refuseMixed?: boolean
  /** The resolver (default: the system's). */
  lookup?: (name: string, options: { family: number }) => Promise<Array<string | { address: string }>>
}

export function nodeDialer(options?: NodeDialerOptions): {
  dial(request: DialRequest): Promise<DialedSocket>
  resolve(request: ResolveRequest): Promise<Array<{ address: string; family: 4 | 6; class: string }>>
}
