/**
 * @johnhenry/browsermesh-egress: a pod lends its network access to peers that hold a grant.
 * The consumer half is browser-safe; the provider half takes its network as `dial` and `resolve` (see `./node`).
 */
import type { Backend, StreamSocket } from '@johnhenry/browsermesh-netway'

/** What a provider answers with when it will not do something. */
export type RefusalCode =
  | 'no-grant' | 'destination-refused' | 'budget-exceeded' | 'wide-not-acknowledged' | 'chaining-refused' | 'shutting-down'
  | 'port-blocked' | 'bad-request' | 'bad-destination' | 'name-not-found' | 'lookup-failed' | 'connect-failed' | 'unknown'
  | 'bad-url' | 'method-not-allowed' | 'redirect-refused' | 'too-many-redirects' | 'bad-response' | 'not-offered'

/** What a consumer reports when the link, not the provider's answer, failed. */
export type LinkCode =
  | 'provider-not-authorized' | 'provider-no-egress' | 'provider-version' | 'provider-timeout' | 'provider-unreachable'
  | 'provider-not-found' | 'provider-refused' | 'signalling-unreachable' | 'provider-gone'
  | 'provider-pin-mismatch' | 'provider-closed' | 'provider-no-form' | 'datagram-too-large' | 'bad-answer' | 'connection-ended' | 'link-closed'
  | 'too-many-connections' | 'aborted'

export type BudgetName = 'connections-per-consumer' | 'connections-global' | 'connect-rate' | 'connect-rate-global' | 'dns-rate' | 'bytes-per-consumer' | 'udp-flows-per-consumer'

/** Why a connection that was open ended. `closed` is the only clean one. */
export type EndReason =
  | 'closed' | 'revoked' | 'shutdown' | 'byte-budget' | 'datagram-budget' | 'consumer-budget' | 'idle' | 'time-budget' | 'stream-abuse' | 'origin-error' | 'consumer-left' | 'up-timeout'

/** The kind of address a destination resolved to (wsh's address guard names them). */
export type AddressClass =
  | 'public' | 'invalid' | 'unspecified' | 'loopback' | 'private' | 'unique-local' | 'link-local' | 'metadata' | 'carrier-nat'
  | 'documentation' | 'benchmarking' | 'multicast' | 'teredo' | 'reserved'

export const REFUSAL_CODES: Readonly<Record<RefusalCode, string>>
export const LINK_CODES: Readonly<Record<LinkCode, string>>
export const BUDGET_NAMES: Readonly<Record<BudgetName, string>>
export const END_REASONS: Readonly<Record<EndReason, string>>

export class EgressError extends Error {
  constructor(code: RefusalCode | LinkCode, message?: string, extra?: { budget?: BudgetName; addressClass?: string; detail?: string; reason?: EndReason; cause?: unknown })
  readonly name: 'EgressError'
  readonly code: RefusalCode | LinkCode
  /** `budget-exceeded`: which budget. */
  readonly budget?: BudgetName
  /** `destination-refused`: what kind of address the destination is. */
  readonly addressClass?: string
  /** `connect-failed`: `refused`, `unreachable`, `timeout`, `certificate` (fetch form) or `failed`. */
  readonly detail?: 'refused' | 'unreachable' | 'timeout' | 'certificate' | 'failed'
  /** `connection-ended`: why the provider ended the connection, when it said. */
  readonly reason?: EndReason
  /** The nearest POSIX error name (`ENOTFOUND`, `ECONNREFUSED`, `ETIMEDOUT`, ...), when there is one. */
  readonly posix?: string
}

// ---------------------------------------------------------------- provider

/** What `dial` returns: a connected Node-style duplex to the address that was checked. */
export interface DialedSocket {
  socket: {
    on(event: string, listener: (...args: any[]) => void): unknown
    once(event: string, listener: (...args: any[]) => void): unknown
    off?(event: string, listener: (...args: any[]) => void): unknown
    write(chunk: Uint8Array): boolean
    end(): unknown
    destroy(): unknown
    pause(): unknown
    resume(): unknown
  }
  /** The address that was checked and dialled. */
  address: string
  /** Its class. With `wide: true` anything but `public` is refused. */
  class: string
  family?: number
}

export interface DialRequest {
  host: string
  port: number
  /** The destination was admitted by a wildcard grant: public addresses only, whatever the operator allows for named destinations. */
  wide: boolean
  signal: AbortSignal
  timeoutMs: number
}

export interface ResolveRequest {
  name: string
  wide: boolean
  signal: AbortSignal
  timeoutMs: number
}

/** What `dialUdp` returns: a datagram socket (`node:dgram` shape) connected to the address that was checked. */
export interface DialedUdpSocket {
  socket: {
    on(event: string, listener: (...args: any[]) => void): unknown
    send(message: Uint8Array, callback?: (error?: Error | null) => void): unknown
    close(): unknown
  }
  address: string
  class: string
  family?: number
}

/** One HTTP exchange the fetch form asks the provider's client for: one request, one response head, a streamed body, over `dial`. */
export interface ExchangeRequest {
  url: string
  method: string
  headers: Array<[string, string]>
  body: AsyncIterable<Uint8Array> | null
  /** The checked dial for this hop: the connection goes to the address that was checked. */
  dial: (request: { host: string; port: number; timeoutMs?: number }) => Promise<DialedSocket>
  signal: AbortSignal
  timeoutMs: number
  maxHeaderBytes: number
  headersTimeoutMs: number
}
export interface ExchangeResponse {
  status: number
  statusText?: string
  headers: Array<[string, string]>
  body: AsyncIterable<Uint8Array>
  destroy?(): void
}

export interface RateLimit { limit: number; windowMs: number }

export interface EgressLimits {
  maxConnectionsPerConsumer: number
  maxConnections: number
  connectRate: RateLimit
  globalConnectRate: RateLimit
  dnsRate: RateLimit
  maxBytesPerConnection: number
  maxBytesPerConsumer: RateLimit & { limit: number }
  connectTimeoutMs: number
  idleMs: number
  maxDurationMs: number
  upWaitMs: number
  meterIntervalMs: number
  maxBadRequests: number
  maxViolations: number
  streamWindowBytes: number
  maxTracked: number
  /** Fetch form: redirects followed for one request, each authorised and address-checked again. */
  maxRedirects: number
  /** Fetch form: bytes of a request's or a response's header block. */
  maxHeaderBytes: number
  /** Fetch form: time from the request to the final response head, every hop together, ms. */
  headersTimeoutMs: number
  /** UDP: bytes of one datagram's payload. */
  maxDatagramBytes: number
  /** UDP: open flows of one consumer. */
  maxUdpFlowsPerConsumer: number
  /** UDP: a flow with nothing moving for this long ends `idle`, ms. */
  udpIdleMs: number
  /** UDP: datagrams per window per consumer, both directions; the rest are dropped. */
  udpDatagramRate: RateLimit
  /** UDP: replies held for a consumer that is not reading; past this they are dropped. */
  udpOutboxBytes: number
  /** UDP: datagrams of one flow, both directions, dropped ones included; then `datagram-budget`. */
  maxUdpDatagramsPerFlow: number
  /** UDP: payload bytes of one flow, both directions; then `byte-budget`. */
  maxUdpBytesPerFlow: number
  /** UDP: reply credit earned per datagram sent is `max(udpReplyFloorBytes, size * udpReplyRatio)`, held up to `udpReplyCreditMaxBytes`. */
  udpReplyRatio: number
  udpReplyFloorBytes: number
  udpReplyCreditMaxBytes: number
  /** `connectByResolvedAddress`: how long an address this provider's own lookup returned is taken for its name, from the lookup, ms. */
  addressMemoryMs: number
  /** `connectByResolvedAddress`: (address, name) pairs remembered per consumer link; the oldest lookup is forgotten first. */
  maxRememberedAddresses: number
}
export const EGRESS_LIMIT_DEFAULTS: Readonly<EgressLimits>

export interface AuditRecord {
  event: 'egress-open' | 'egress-close' | 'egress-refused' | 'egress-resolve' | 'egress-abuse' | 'egress-hop'
  at: number
  outcome: 'opened' | 'closed' | 'refused' | 'answered' | 'hop'
  peer: string
  form?: 'tcp' | 'dns' | 'fetch' | 'udp'
  host?: string
  port?: number
  address?: string
  addressClass?: string
  bytesUp?: number
  bytesDown?: number
  durationMs?: number
  /** `egress-close`: an EndReason. */
  reason?: string
  /** `egress-refused`: a RefusalCode. */
  code?: RefusalCode
  budget?: BudgetName
  detail?: string
  via?: 'exact' | 'host' | 'set' | 'wide'
  /** Fetch form: the method, the redirect hop (`egress-hop`), the final status and the redirects followed. */
  method?: string
  hop?: number
  status?: number
  redirects?: number
  /** Fetch form: the length of the path and query; never the path unless the operator chose `auditUrls`. */
  pathLength?: number
  /** Only with `auditUrls: 'path'` or `'full'`. */
  path?: string
  /** Only with `auditUrls: 'full'`. */
  query?: string
  /** UDP, `egress-close`: datagrams passed on each way and datagrams dropped each way. */
  datagramsUp?: number
  datagramsDown?: number
  droppedUp?: number
  droppedDown?: number
}

export interface MeterRecord {
  peer: string
  form: 'tcp' | 'dns' | 'fetch' | 'udp'
  /** 1 on the final record of a connection or a lookup, 0 on the periodic deltas of a long connection. */
  connections: number
  bytesUp: number
  bytesDown: number
  durationMs: number
  reason?: string
  final: boolean
}

export interface MeshEgressOptions {
  /** A mesh service with the protocol channel (`attachService(node, undefined, createMeshProtocolService())`, or its `.api`). */
  service: object
  /** The grants are the registry's. */
  registry: { checkAccess(podId: string, resource: string, action: string): boolean | { allowed: boolean }; onAccessChange?: (cb: (change?: { pubKey?: string }) => void) => () => void }
  /** Resolve once, check the address, connect to the address that was checked. */
  dial: (request: DialRequest) => Promise<DialedSocket>
  /** The A records of a name, checked by the same policy. */
  resolve: (request: ResolveRequest) => Promise<Array<string | { address: string; family?: number; class?: string }>>
  /**
   * The fetch form's HTTP client (`nodeDialer().exchange`). Without it the fetch form is answered `not-offered`. THE PROVIDER SEES the
   * URL, headers, bodies and responses it carries in plaintext.
   */
  exchange?: (request: ExchangeRequest) => Promise<ExchangeResponse>
  /** The UDP form's socket (`nodeDialer().dialUdp`): resolve once, check, connect a datagram socket to the checked address. Without it UDP is answered `not-offered`. */
  dialUdp?: (request: DialRequest) => Promise<DialedUdpSocket>
  /** Methods the fetch form serves (default `['GET', 'HEAD']`; CONNECT and TRACE are never served). */
  fetchMethods?: Array<'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS'>
  /** Add `x-browsermesh-consumer: <pod id>` to each fetch request (default false: the destination never learns who asked). */
  identifyConsumers?: boolean
  /**
   * Default false. Take a `connect` to an ADDRESS that this provider's own lookup returned for the consumer (under its `dns` grant, for
   * `limits.addressMemoryMs`, at most `limits.maxRememberedAddresses` per link) as a connect to that name under the name's TCP grant. The
   * address is dialled as it is (no second lookup), through the same checked `dial`; an address of a name the consumer has no TCP grant
   * for gives nothing. For a guest operating system that connects by the address its lookup returned.
   */
  connectByResolvedAddress?: boolean
  /** The keep-alive: ping each consumer every `intervalMs` (default 5000); a consumer heard from in no way for `misses` intervals (default 3) is gone. `false`: do not ping (pings of a consumer are still answered). */
  keepAlive?: boolean | KeepAliveOptions
  /** What the audit says of a URL: `'none'` (default: the length only), `'path'` or `'full'` (path and query). */
  auditUrls?: 'none' | 'path' | 'full'
  /** UDP ports no one reaches (default `[53]`: names are looked up through the lookup form). With wide mode 53 cannot be removed. */
  blockedUdpPorts?: number[]
  /** Operator-named destination sets: `host:ports`, `*.suffix:ports`, `a.b.c.d/n:ports`, `a.b.c.d:ports`. */
  sets?: Record<string, string[]>
  /** `{ acknowledge: 'any-public-address' }`: a holder of a wildcard grant may reach any public destination. */
  wide?: { acknowledge: 'any-public-address' }
  /** Default `[25, 465, 587]`. With wide mode the defaults cannot be removed. */
  blockedPorts?: number[]
  limits?: Partial<EgressLimits>
  allowFrom?: string[] | ((podId: string, context: { peer: string; protocol: string; version: number }) => boolean | Promise<boolean>)
  deny?: (destination: { peer: string; host: string; port: number }) => boolean | Promise<boolean>
  verifyRequest?: (info: { peer: string; bytes: Uint8Array; sig: string | undefined; request: object }) => boolean | Promise<boolean>
  indicator?: { connected(who: object, control: { stop(): Promise<boolean> }): void; disconnected(who: object): void }
  unattended?: boolean
  onAudit?: (record: AuditRecord) => void
  onMeter?: (record: MeterRecord) => void
  clock?: { now: () => number }
  recheckIntervalMs?: number
  protocol?: string
  onLog?: (...args: unknown[]) => void
}

export interface EgressStats {
  channels: number
  requests: number
  opened: number
  refused: number
  closed: number
  lookups: number
  bytesUp: number
  bytesDown: number
  /** Keep-alive pings this provider sent, answers it heard to them, and consumers it declared gone. */
  pings: number
  pongs: number
  gone: number
  open: number
  reasons: Record<string, number>
  ends: Record<string, number>
  fetches: number
  udp: { flows: number; datagramsUp: number; datagramsDown: number; dropped: { rate: number; credit: number; size: number; outbox: number } }
  peers: Record<string, { connections: number; open: number; bytesUp: number; bytesDown: number; refused: number; lookups: number }>
}

export interface MeshEgress {
  /** Begin serving. Throws unless an indicator was given or `unattended: true`. */
  start(): void
  /** End every connection (`shutdown`) and stop serving. There is no resume. */
  stop(): Promise<void>
  /** Ask the registry again about every live connection (of `peer`, or all); one whose grant is gone ends `revoked`. */
  recheck(peer?: string): void
  readonly started: boolean
  readonly connections: Array<{ peer: string; host: string; port: number; address?: string; since: number; bytesUp: number; bytesDown: number }>
  stats(): EgressStats
}

export function createMeshEgress(options: MeshEgressOptions): MeshEgress
export const DEFAULT_BLOCKED_PORTS: readonly number[]
export const DEFAULT_BLOCKED_UDP_PORTS: readonly number[]
export const WIDE_ACKNOWLEDGEMENT: 'any-public-address'

// ---------------------------------------------------------------- consumer

export interface ConsumerLimits {
  openTimeoutMs: number
  requestTimeoutMs: number
  maxConnections: number
  streamWindowBytes: number
  socketWindowBytes: number
  maxViolations: number
}
export const CONSUMER_LIMIT_DEFAULTS: Readonly<ConsumerLimits>

export interface KeepAliveOptions {
  /** A ping every this many ms (default 5000). */
  intervalMs?: number
  /** The other end is gone after this many intervals in which nothing at all was heard from it (default 3: noticed within about 15 s). */
  misses?: number
}
export const KEEPALIVE_DEFAULTS: Readonly<Required<KeepAliveOptions>>

export interface ConnectEgressOptions {
  signal?: AbortSignal
  limits?: Partial<ConsumerLimits>
  signRequest?: (bytes: Uint8Array, info: { peer: string }) => string | Promise<string>
  protocol?: string
  onLog?: (...args: unknown[]) => void
  /** The link's keep-alive (default on: a ping every 5 s, gone after 3 silent intervals). `false` leaves it to the transport's own timers (minutes). */
  keepAlive?: boolean | KeepAliveOptions
  /**
   * Default false. Remember what this link's lookups answered; when the provider refuses an ADDRESS (`no-grant`) that was answered for a name,
   * ask for the name instead (a guest OS connects by the address it was given). Only a name this link looked up itself, only on `no-grant`.
   */
  mapAddresses?: boolean | { ttlMs?: number; maxEntries?: number }
}

/** Why a link ended: `link.closeReason`, `link.whenClosed`, `link.onClose`. */
export type CloseReason = 'local-close' | 'provider-gone' | 'provider-closed' | 'provider-stopped' | 'revoked' | 'provider-refused' | 'protocol-violation'
export const CLOSE_REASONS: Readonly<Record<CloseReason, string>>

/** Which names an address was answered for, bounded in time and in count (what `connectByResolvedAddress` and `mapAddresses` use). */
export function createAddressMemory(options: { ttlMs: number; maxEntries: number; now?: () => number }): {
  remember(name: string, addresses: unknown[]): void
  /** The names this address was answered for, most recent first. */
  namesFor(address: string): string[]
  readonly size: number
  clear(): void
}

export interface EgressLink {
  /** The provider's pod id (the channel's verified peer). */
  readonly peer: string
  /** True once the link has ended, for any reason. (A boolean, as it has always been: see `whenClosed` and `onClose` for the reason.) */
  readonly closed: boolean
  /** Why the link ended, or `undefined` while it is up. */
  readonly closeReason: CloseReason | undefined
  /** Resolves `{ reason }` when the link ends. */
  readonly whenClosed: Promise<{ reason: CloseReason }>
  /** `cb({ reason })` once, when the link ends (asynchronously, at once, if it already has). Returns a function that removes the listener. */
  onClose(cb: (info: { reason: CloseReason }) => void): () => void
  /** The names this link's own lookups answered `address` for, newest first (empty unless `mapAddresses` is on). */
  namesFor(address: string): string[]
  /** Open TCP to `host:port`. Resolves with a netway `StreamSocket`: `read()`, `write()`, `end()` (half-close), `close()`, `destroy()`. */
  connect(host: string, port: number, options?: { signal?: AbortSignal }): Promise<StreamSocket>
  /** The IPv4 addresses of a name. Rejects `name-not-found` (`posix: 'ENOTFOUND'`) for a name that does not exist. */
  lookup(name: string, options?: { signal?: AbortSignal }): Promise<string[]>
  /**
   * `fetch` through the provider. THE PROVIDER IS THE HTTP CLIENT: it does the TLS for `https:` and sees the URL, headers, bodies and
   * response in plaintext. Redirects are followed by the provider only to destinations you also hold a grant for; no cookies either way.
   * Rejects with an `EgressError`; an aborted signal rejects with its reason. The body streams only as it is read.
   */
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>
  /** One UDP flow to one destination. See `EgressUdpFlow`. */
  udp(host: string, port: number, options?: { signal?: AbortSignal }): Promise<EgressUdpFlow>
  /** A netway `Backend` for `VirtualNetwork.addBackend('tcp', ...)`. */
  asBackend(): EgressBackend
  stats(): { connections: number; refused: number; lookups: number; bytesUp: number; bytesDown: number; pings: number; pongs: number; open: number }
  close(): Promise<void>
}

/**
 * A UDP flow. Datagram semantics beyond the provider, and the provider drops what it will not pass on (silently, as a network
 * would). The datagrams read are the provider's word: a provider can invent a reply.
 */
export interface EgressUdpFlow extends AsyncIterable<Uint8Array> {
  /** The longest datagram the provider passes on for this flow. */
  readonly maxDatagramBytes: number
  readonly closed: boolean
  /** Rejects `datagram-too-large` above `maxDatagramBytes`; resolves when the provider has taken the datagram. */
  send(datagram: Uint8Array | ArrayBuffer | ArrayBufferView): Promise<void>
  /** The next datagram, or null once the flow ended cleanly; rejects with an `EgressError` (`connection-ended` with a `reason`, ...) when it ended otherwise. */
  read(): Promise<Uint8Array | null>
  close(): Promise<void>
}

export function connectEgress(service: object, provider: string, options?: ConnectEgressOptions): Promise<EgressLink>

export class EgressBackend extends Backend {
  constructor(link: EgressLink)
  readonly link: EgressLink
  connect(host: string, port: number): Promise<StreamSocket>
  resolve(name: string, type?: 'A'): Promise<string[]>
}

// ---------------------------------------------------------------- shared

export const EGRESS_SCOPES: Readonly<{
  tcp(host: string, port: number): string
  tcpAnyPort(host: string): string
  dns(name: string): string
  set(name: string): string
  /** The fetch form: the provider makes the HTTP(S) request and sees it in plaintext. */
  http(host: string, port: number): string
  httpAnyPort(host: string): string
  setFetch(name: string): string
  udp(host: string, port: number): string
  udpAnyPort(host: string): string
  setUdp(name: string): string
}>

export interface SetEntry { text: string; kind: 'name' | 'suffix' | 'ipv4' | 'cidr'; ports: '*' | number[][] }
export function parseSetEntry(entry: string, where?: string): SetEntry
export function compileSets(sets?: Record<string, string[]>): Map<string, SetEntry[]>

export function parseBytes(text: string): number
export function parseDuration(text: string): number

export const EGRESS_PROTOCOL: 'egress'
export const EGRESS_VERSIONS: readonly number[]
/** Marks a function or object as an egress consumer; a provider refuses to be built on one. */
export const EGRESS_CONSUMER: unique symbol
export function signedRequestBytes(fields: { form: 'connect' | 'resolve' | 'fetch' | 'udp'; cid?: number; nonce: string; host: string; port?: number }): Uint8Array
