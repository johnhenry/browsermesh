/**
 * @johnhenry/browsermesh-egress: a pod lends its network access to peers that hold a grant.
 * The consumer half is browser-safe; the provider half takes its network as `dial` and `resolve` (see `./node`).
 */
import type { Backend, StreamSocket } from '@johnhenry/browsermesh-netway'

/** What a provider answers with when it will not do something. */
export type RefusalCode =
  | 'no-grant' | 'destination-refused' | 'budget-exceeded' | 'wide-not-acknowledged' | 'chaining-refused' | 'shutting-down'
  | 'port-blocked' | 'bad-request' | 'bad-destination' | 'name-not-found' | 'lookup-failed' | 'connect-failed' | 'unknown'

/** What a consumer reports when the link, not the provider's answer, failed. */
export type LinkCode =
  | 'provider-not-authorized' | 'provider-no-egress' | 'provider-version' | 'provider-timeout' | 'provider-unreachable'
  | 'provider-pin-mismatch' | 'provider-closed' | 'bad-answer' | 'connection-ended' | 'link-closed' | 'too-many-connections' | 'aborted'

export type BudgetName = 'connections-per-consumer' | 'connections-global' | 'connect-rate' | 'connect-rate-global' | 'dns-rate' | 'bytes-per-consumer'

/** Why a connection that was open ended. `closed` is the only clean one. */
export type EndReason =
  | 'closed' | 'revoked' | 'shutdown' | 'byte-budget' | 'consumer-budget' | 'idle' | 'time-budget' | 'stream-abuse' | 'origin-error' | 'consumer-left' | 'up-timeout'

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
  /** `connect-failed`: `refused`, `unreachable`, `timeout` or `failed`. */
  readonly detail?: 'refused' | 'unreachable' | 'timeout' | 'failed'
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
}
export const EGRESS_LIMIT_DEFAULTS: Readonly<EgressLimits>

export interface AuditRecord {
  event: 'egress-open' | 'egress-close' | 'egress-refused' | 'egress-resolve' | 'egress-abuse'
  at: number
  outcome: 'opened' | 'closed' | 'refused' | 'answered'
  peer: string
  form?: 'tcp' | 'dns'
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
}

export interface MeterRecord {
  peer: string
  form: 'tcp' | 'dns'
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
  open: number
  reasons: Record<string, number>
  ends: Record<string, number>
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

export interface ConnectEgressOptions {
  signal?: AbortSignal
  limits?: Partial<ConsumerLimits>
  signRequest?: (bytes: Uint8Array, info: { peer: string }) => string | Promise<string>
  protocol?: string
  onLog?: (...args: unknown[]) => void
}

export interface EgressLink {
  /** The provider's pod id (the channel's verified peer). */
  readonly peer: string
  readonly closed: boolean
  /** Open TCP to `host:port`. Resolves with a netway `StreamSocket`: `read()`, `write()`, `end()` (half-close), `close()`, `destroy()`. */
  connect(host: string, port: number, options?: { signal?: AbortSignal }): Promise<StreamSocket>
  /** The IPv4 addresses of a name. Rejects `name-not-found` (`posix: 'ENOTFOUND'`) for a name that does not exist. */
  lookup(name: string, options?: { signal?: AbortSignal }): Promise<string[]>
  /** A netway `Backend` for `VirtualNetwork.addBackend('tcp', ...)`. */
  asBackend(): EgressBackend
  stats(): { connections: number; refused: number; lookups: number; bytesUp: number; bytesDown: number; open: number }
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
export function signedRequestBytes(fields: { form: 'connect' | 'resolve'; cid?: number; nonce: string; host: string; port?: number }): Uint8Array
