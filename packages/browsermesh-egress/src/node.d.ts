/**
 * @johnhenry/browsermesh-egress/node: the provider's `dial`, `dialUdp`, `resolve` and `exchange` on wsh's address guard (`@johnhenry/wsh/address-guard`).
 */
import type { DialRequest, DialedSocket, DialedUdpSocket, ExchangeRequest, ExchangeResponse, ResolveRequest } from './index.js'

export { createMeshEgress, DEFAULT_BLOCKED_PORTS, DEFAULT_BLOCKED_UDP_PORTS, WIDE_ACKNOWLEDGEMENT } from './index.js'

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
  /** Certificate authorities trusted for the fetch form's `https:` instead of Node's own list (a private PKI). */
  ca?: string | Buffer | Array<string | Buffer>
}

export function nodeDialer(options?: NodeDialerOptions): {
  dial(request: DialRequest): Promise<DialedSocket>
  /** The UDP form's seam: a datagram socket connected to the checked address (the kernel drops datagrams from any other source). */
  dialUdp(request: DialRequest): Promise<DialedUdpSocket>
  resolve(request: ResolveRequest): Promise<Array<{ address: string; family: 4 | 6; class: string }>>
  /** The fetch form's HTTP client, over the checked `dial`. THIS is the one place the package terminates TLS. */
  exchange: (request: ExchangeRequest) => Promise<ExchangeResponse>
}

/** The fetch form's HTTP client by itself (`nodeDialer` builds one). */
export function createExchange(options?: { ca?: string | Buffer | Array<string | Buffer> }): (request: ExchangeRequest) => Promise<ExchangeResponse>
export const nodeExchange: (request: ExchangeRequest) => Promise<ExchangeResponse>
