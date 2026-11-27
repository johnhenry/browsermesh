/**
 * @johnhenry/browsermesh-ingress: real HTTP in, a mesh pod answers.
 */

/** How the identity of the pod at the other end of a link was established (`PeerIdentity.verified`). */
export type PeerVerified = 'bound' | 'wsh' | 'key' | 'none'

/**
 * What is VERIFIED about the pod at the other end of a link, as opposed to merely claimed.
 *
 * - `bound`: a direct WebRTC connection on which the peer proved possession of the key behind its pod id (identity binding).
 * - `wsh`: a wsh peer link (key-authenticated in both directions, sealed).
 * - `key`: more than one of those at once.
 * - `none`: nothing was proven; `keyId` and `publicKey` are absent.
 */
export interface PeerIdentity {
  /** The pod id of the other end (the same string the hooks' `peer` has). */
  readonly podId: string
  readonly verified: PeerVerified
  /** Present when `verified` is not `'none'`: base64url SHA-256 of the pod's public key (equal to `podId`). */
  readonly keyId?: string
  /** Present only when the source supplied the 32 raw key bytes and they hash to `podId`. */
  readonly publicKey?: Uint8Array
}

/** What a link-identity source says about a link: a proof, or nothing (`undefined`). It can only narrow. */
export type LinkIdentityResult = { verified: Exclude<PeerVerified, 'none'>; publicKey?: Uint8Array } | undefined
export type LinkIdentity = (podId: string) => LinkIdentityResult | Promise<LinkIdentityResult>

/** A mesh node, as far as `nodeLinkIdentity` reads it (a `createMeshNode` result has all of this). */
export interface MeshNodeLike {
  sessionsFor(podId: string): Array<{ state?: string; transport?: string | null; connectionId?: string }>
  meshManager?: { getConnection(podId: string, connectionId?: string): { bound?: boolean; isOpen?: boolean } | null }
  wsh?: { links?: { isConnected(podId: string): boolean } }
}

/** The link-identity source for a mesh node: a proof only when every live session to the pod carries one. */
export function nodeLinkIdentity(node: MeshNodeLike): (podId: string) => { verified: 'bound' | 'wsh' | 'key' } | undefined

/** What `requireLinkKey` refuses for. */
export const LINK_KEY_REFUSALS: Readonly<{
  linkUnverified: 'link-unverified'
  signerUnverified: 'signer-unverified'
  signerKeyInvalid: 'signer-key-invalid'
  mismatch: 'link-key-mismatch'
}>
export const PEER_VERIFIED: readonly PeerVerified[]
/** What `requireLinkKey` throws to refuse; the provider logs and counts `reason`. */
export class LinkKeyRefusal extends Error {
  constructor(reason: string)
  readonly reason: string
}

/**
 * Make a `verifyRequest` (or `verifyResponse`) hook that binds the signer to the link. `verifySigner` does the signature
 * check and returns the verified signer's raw 32-byte key (or its key id, base64url SHA-256 of the key), or a falsy value. The
 * hook accepts only when the link proved a key (`peer.verified !== 'none'`) and the signer's key is the link's key. The peer
 * object is the hook's last argument.
 */
export function requireLinkKey<A extends unknown[]>(
  verifySigner: (...args: A) => Uint8Array | string | false | null | undefined | Promise<Uint8Array | string | false | null | undefined>,
): (...args: [...A]) => Promise<true>

export interface RequestVerifyContext {
  peer: string
  sig: string | undefined
  bytes: Uint8Array
  rid: number
  nonce: string
}

export interface ProviderOptions {
  /** The ingress pods served: a non-empty list of pod ids, or a function (asked on open and for every request; only `true` serves). */
  allowFrom: string[] | ((podId: string, context: { peer: string; protocol: string; version: number }, peer: PeerIdentity) => boolean | Promise<boolean>)
  limits?: Partial<typeof PROVIDER_LIMIT_DEFAULTS>
  /** Sign the response (the provider buffers it so the signature covers the body). */
  sign?: (bytes: Uint8Array, info: { peer: string }) => string | Promise<string>
  /** Runs before the handler; only `true` lets the request through. `peer` (third argument) says what the link proved. */
  verifyRequest?: (request: Request, context: RequestVerifyContext, peer: PeerIdentity) => boolean | Promise<boolean>
  /** A mesh node: what `peer` says about a link is read from its sessions (`nodeLinkIdentity`). Without it or `linkIdentity`, `verified` is always `'none'`. */
  node?: MeshNodeLike
  /** A custom source for `peer`, in place of `node`. */
  linkIdentity?: LinkIdentity
  /**
   * Named services this pod serves besides (or instead of) the one handler. A route that names a service reaches that handler,
   * which finds the name in `context.service`. A pod that declares nothing is never sent a service name. With `services`, the
   * handler argument may be `null` (no default: a route with no service is refused).
   */
  services?: Record<string, Handler | { fetch: Handler; methods?: MethodPolicy; maxBodyBytes?: number }>
  /**
   * The methods this pod serves: `'*'` (the default: every RFC 9110 method token, never CONNECT, TRACE or TRACK) or a list that
   * NARROWS it, for example `['GET', 'HEAD']`. This pod's own word: an ingress cannot widen it. For a service it overrides this.
   */
  methods?: MethodPolicy
  /** The request body this pod takes, in bytes, streamed to the handler (default 32 MiB; `Infinity` lifts it). For a service it overrides this. */
  maxBodyBytes?: number
  /** Protocol `http` versions this pod speaks (default `[1, 2]`; `[1]` behaves as a pod that predates streaming: GET and HEAD, bodies held whole). */
  versions?: number[]
  protocol?: string
  onLog?: (event: string, data: object) => void
}

/** `'*'` is every method token this package carries; a list names the ones it does. */
export type MethodPolicy = '*' | string[]

export const PROVIDER_LIMIT_DEFAULTS: Readonly<{
  maxInflight: number
  /** A request body this pod must hold whole (a signed request, a link that negotiated version 1), bytes. */
  maxRequestBodyBytes: number
  maxResponseBytes: number
  handlerTimeoutMs: number
  bodyWaitMs: number
  /** Longest wait for the next chunk of a request body, ms. */
  bodyIdleMs: number
  /** Whole request that carries a body, ms (the handler's deadline is the longer of this and `handlerTimeoutMs`). */
  uploadTimeoutMs: number
  /** Requests with a body being taken on one link at once. */
  maxUploads: number
  maxHeaderCount: number
  maxHeaderBytes: number
  maxTargetLength: number
}>
/** What a pod takes as a request body unless it says otherwise: 32 MiB. */
export const DEFAULT_MAX_BODY_BYTES: number

export type Handler = (request: Request, context: { peer: string; signal: AbortSignal; client: string | undefined; service?: string }) => Response | Promise<Response>

/** Serve `handler` over protocol `http` v1 to the ingress pods `allowFrom` names. `handler` may be `null` when `options.services` is given. */
export function serveHttpOnMesh(
  service: object,
  handler: Handler | { fetch: Handler } | null,
  options: ProviderOptions,
): {
  /** Stop serving; resolves once the channels' close notices have left this pod. `graceMs` (default 0) lets the requests being answered finish first, for at most that long; requests that arrive meanwhile are refused (the ingress answers 503 `provider-stopping`). */
  stop(options?: { graceMs?: number }): Promise<void>
  stats(): Record<string, number | Record<string, number>> & { refusals: Record<string, number> }
}

/** A handler's way to say "not me, try another". */
export function declineRequest(): Response

/** Wrap a serverless site handler as a `(Request) => Response` handler. */
export function fromSiteHandler(onRequest: (req: { fromPubKey?: string; method: string; path: string; headers: Record<string, string>; body?: unknown }) => Promise<{ status: number; headers: Record<string, string>; body: unknown }>): Handler

export interface IngressMapping {
  peer: string
  /** The named service on that pod the route is for (the pod must have declared it with `serveHttpOnMesh`'s `services`). */
  service?: string
  path?: string
  headers?: Record<string, string>
  response?: { contentSecurityPolicy?: string | false; cacheControl?: string | false; allowSetCookie?: boolean; addHeaders?: Record<string, string> }
}

export interface IngressOptions {
  service?: object
  node?: object
  /** Required unless `names` is given. The operator's mappings are asked first, names pods claimed after. */
  resolve?: (request: Request, attempt: { attempt: number; tried: string[] }) => IngressMapping | null | Promise<IngressMapping | null>
  /** A name table (`createNameTable`): hosts under its zone that pods claimed are served, and a name in its hold waits for its pod. */
  names?: NameTable
  retry?: { attempts: number; on?: string[]; nonIdempotent?: boolean }
  /** Sign each request for the provider's `verifyRequest`. `link` (third argument) says what the link to the provider proved. */
  signRequest?: (bytes: Uint8Array, info: { peer: string }, link: PeerIdentity) => string | Promise<string>
  /** Signed responses. `link` (second argument) says what the link to the provider proved. */
  verifyResponse?: (info: { peer: string; bytes: Uint8Array; sig: string; request: { rid: number; method: string; target: string; host: string } }, link: PeerIdentity) => boolean | Promise<boolean>
  /** Where `link` comes from, in place of reading `node` (when that is a mesh node). */
  linkIdentity?: LinkIdentity
  authorize?: (request: Request, target: IngressMapping) => boolean | Promise<boolean>
  deny?: (request: Request) => Response | boolean | null | Promise<Response | boolean | null>
  limits?: Partial<typeof INGRESS_LIMIT_DEFAULTS>
  /**
   * The methods this process carries: `'*'` (the default: every method token, never CONNECT, TRACE or TRACK) or a list that
   * NARROWS it. A pod that has not upgraded (protocol version 1) is sent GET and HEAD only (or, for a list written here, the
   * standard methods in it, with the body held whole).
   */
  methods?: MethodPolicy
  /** Protocol `http` versions offered (default `[2, 1]`; `[1]` behaves as an ingress that predates streaming). */
  versions?: number[]
  forwardHeaders?: string[]
  exposeHeaders?: string[]
  forwardClientAddress?: boolean
  rpc?: { request: Function }
  onAudit?: (record: object) => void
  clock?: { now: () => number }
  protocol?: string
}

export interface MeshIngress {
  handle(request: Request, info?: { clientAddress?: string }): Promise<Response>
  /**
   * Tell the ingress a pod is about to be wanted: it is dialled now and, with `persist` (the default), kept dialled; a request for it
   * that arrives while the link is not up waits up to `graceMs` (default `limits.linkWaitMs`, 5 s) and never past its own deadline.
   */
  expect(podId: string, options?: { graceMs?: number; persist?: boolean; retryMs?: number }): void
  /** `ready` is true when every pod expected for good has a live link. It never names a pod. */
  readiness(): { ready: boolean; peers: { up: number; total: number } }
  whenReady(options?: { timeoutMs?: number }): Promise<boolean>
  stats(): Record<string, unknown>
  close(): Promise<void>
}

export const NAMES_PROTOCOL: 'ingress-names'
export const NAMES_VERSIONS: readonly number[]
export const NAME_DENY_DEFAULTS: readonly string[]
export class NameRefusal extends Error {
  constructor(reason: string, message?: string, extra?: { retryAfterMs?: number })
  readonly reason: string
  readonly retryAfterMs?: number
}
export function checkLabel(label: unknown): string
export function checkService(service: unknown): string | undefined

export interface NameTableOptions {
  /** The hostname names live under: a claim for `app` is the host `app.<zone>`. */
  zone: string
  /** The operator's grant per pod and name; only `true` allows. Without it nothing is claimable. */
  allow?: (podId: string, label: string) => boolean | Promise<boolean>
  /** Labels (a trailing `*` is a prefix) refused on top of `NAME_DENY_DEFAULTS`, even when `allow` says yes. */
  deny?: string[]
  maxNames?: number
  maxPerPod?: number
  /** How long a name stays its holder's after the holder's link goes (default 30000; 0 frees it at once). */
  holdMs?: number
  claimRate?: { limit: number; windowMs: number }
  /** Hosts the operator maps by hand: not claimable. */
  reserved?: (host: string) => boolean
  clock?: { now: () => number }
  onAudit?: (record: { type: 'name'; action: 'claim' | 'refuse' | 'release' | 'hold' | 'expire'; pod: string; name: string; reason?: string }) => void
  onChange?: (event: { type: 'claimed' | 'released' | 'held' | 'expired'; pod: string; name: string; service?: string; holdMs?: number }) => void
}

export interface NameTable {
  readonly zone: string
  claim(podId: string, label: string, options?: { link?: unknown; service?: string }): Promise<{ name: string; host: string; service: string | undefined }>
  release(podId: string, label: string): boolean
  linkLost(podId: string, link: unknown): void
  lookup(host: string): { peer: string; service: string | undefined; name: string; held: boolean } | null
  namesOf(podId: string): Array<{ name: string; host: string; service: string | undefined; held: boolean }>
  subscribe(listener: NonNullable<NameTableOptions['onChange']>): () => boolean
  stats(): { names: number; held: number }
}

export function createNameTable(options: NameTableOptions): NameTable
/** `allow` for `createNameTable` from a PeerRegistry: the scope `ingress:name:<label>:claim`. */
export function registryAllow(registry: { checkAccess(podId: string, resource: string, action: string): { allowed: boolean } }): (podId: string, label: string) => boolean
/** The ingress end of protocol `ingress-names` v1. */
export function serveIngressNames(service: object, table: NameTable): { stop(): void; stats(): Record<string, number> }
/** The pod's end: claim, release and list names over one channel; the channel is the claim's lifetime. */
export function openNameClient(service: object, ingressPodId: string, options?: { timeoutMs?: number }): Promise<{
  channel: object
  claim(name: string, options?: { service?: string }): Promise<{ name: string; host: string; service?: string }>
  release(name: string): Promise<{ released: boolean }>
  names(): Promise<Array<{ name: string; host: string; service?: string; held: boolean }>>
  onClose(callback: () => void): void
  close(): void
}>

export function createMeshIngress(options: IngressOptions): MeshIngress

/**
 * Every bound, with its default. `maxRequestBodyBytes` (32 MiB, `Infinity` only by choice) is what is streamed for one request;
 * `maxBufferedBodyBytes` (1 MiB) is what is held whole for an older provider, a signed request or a request that `retry` may repeat;
 * `uploadTimeoutMs` (5 min) is the whole-request deadline of a request with a body (`timeoutMs`, 30 s, is for one without);
 * `bodyIdleMs` (10 s) is the longest wait for the next chunk from the client; `maxUploadsPerProvider` (4) caps requests with a body
 * in flight to one pod.
 */
export const INGRESS_LIMIT_DEFAULTS: Readonly<Record<string, number | Readonly<{ limit: number; windowMs: number }>>>
export function parseBytes(text: string): number
export function parseDuration(text: string): number

export class IngressError extends Error {
  constructor(status: number, reason: string, message?: string, extra?: { headers?: Record<string, string> })
  readonly status: number
  readonly reason: string
  readonly headers?: Record<string, string>
}
export const REASON_HEADER: 'x-browsermesh-ingress-reason'

export const DEFAULT_CSP: string
export const DEFAULT_FORWARD_REQUEST_HEADERS: readonly string[]
export const DEFAULT_PASS_RESPONSE_HEADERS: readonly string[]
export const HTTP_PROTOCOL: 'http'
/** `[1, 2]`: version 1 is the seven standard methods with a body held whole; version 2 is any method token with a body streamed, and `capabilities`. */
export const HTTP_VERSIONS: readonly number[]
export function signedBytes(parts: { rid: number; nonce: string; host: string; method: string; target: string; status: number; headers: Array<[string, string]>; digest: string }): Uint8Array
export function signedRequestBytes(parts: { rid: number; nonce: string; host: string; method: string; target: string; headers: Array<[string, string]>; client?: string; digest: string; service?: string }): Uint8Array
