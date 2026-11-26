/**
 * provider.mjs -- `createMeshEgress`: a pod lends its network access to peers that hold a grant.
 *
 * Off unless the embedder creates and starts one. Then, for each peer that may open protocol `egress` (the protocol host's
 * own gate, `protocol:egress:open`, default deny), each request is checked against the registry's grants for THAT destination
 * (`egress:tcp:<host>:<port>:connect`, `egress:tcp:<host>:*:connect`, `egress:set:<name>:connect`, `egress:dns:<name>:resolve`),
 * against the operator's blocked ports and budgets, and, after resolution, against the operator's address policy, which is
 * wsh's address guard behind the `dial` and `resolve` options (see `./node`). The connection goes to the address that was
 * checked. Bytes are relayed as they are; nothing is read, logged or altered.
 *
 * This file imports no `node:` module and no wsh: the network is the `dial` and `resolve` the embedder passes.
 */
import { createStreamLayer } from '@johnhenry/browsermesh-apps/protocol-stream'
import { ChannelErrorCode, MeshChannelError } from '@johnhenry/browsermesh-apps/mesh-channel'
import { setsCovering, compileSets, EGRESS_SCOPES } from './destination.mjs'
import { BUDGET_NAMES, EgressError, REFUSAL_CODES, refusalAnswer } from './errors.mjs'
import { CONSUMER_HEADER, DEFAULT_FETCH_METHODS, FETCH_USER_AGENT, KNOWN_METHODS, MAX_HEADERS, NO_BODY_STATUSES, REDIRECT_STATUSES, headerBytes, originOf, parseTarget, requestHeaders, responseHeaders } from './http-policy.mjs'
import { createByteBudget, createInflight, createRateLimiter, resolveLimits } from './limits.mjs'
import {
  CONNECT_METHOD, EGRESS_CONSUMER, EGRESS_PROTOCOL, EGRESS_VERSIONS, END_METHOD, FETCH_METHOD, KIND_DOWN, KIND_UP, MAX_ANSWER_ADDRESSES, RESOLVE_METHOD, UDP_METHOD,
  createFrameReader, encodeDatagram, signedRequestBytes, validateConnect, validateFetch, validateResolve, validateStreamMeta,
} from './wire.mjs'

/** Ports refused by default: mail submission (SMTP relay, SMTPS, submission). */
export const DEFAULT_BLOCKED_PORTS = Object.freeze([25, 465, 587])
/** UDP ports refused by default: DNS. A name is looked up through the lookup form (its own grant and rate), not by talking to a resolver. */
export const DEFAULT_BLOCKED_UDP_PORTS = Object.freeze([53])
/** What an operator writes to acknowledge wide mode: any PUBLIC destination for a holder of a wildcard grant. */
export const WIDE_ACKNOWLEDGEMENT = 'any-public-address'

/** The scope family and action of each form of request. */
const FORMS = Object.freeze({
  tcp: Object.freeze({ family: 'tcp', action: 'connect' }),
  fetch: Object.freeze({ family: 'http', action: 'fetch' }),
  udp: Object.freeze({ family: 'udp', action: 'send' }),
})

const unref = (t) => { t?.unref?.(); return t }
const text = (s, max = 253) => (typeof s === 'string' ? s.slice(0, max) : undefined)
const isPodId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s)

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  promise.catch(() => {})
  return { promise, resolve, reject }
}

/** What went wrong in `dial` or `resolve`, as a refusal. Duck-typed on wsh's `AddressGuardError`; no import of it. */
function refusalOf(e, phase) {
  const code = e?.code
  if (code === 'ADDRESS_REFUSED') {
    const addressClass = Array.isArray(e.refused) && typeof e.refused[0]?.class === 'string' ? e.refused[0].class : undefined
    return refusalAnswer('destination-refused', { addressClass })
  }
  if (code === 'NAME_NOT_FOUND' || code === 'ENOTFOUND') return refusalAnswer('name-not-found')
  if (code === 'LOOKUP_FAILED' || code === 'EAI_AGAIN') return refusalAnswer('lookup-failed')
  if (phase === 'resolve') return refusalAnswer('lookup-failed')
  if (code === 'CONNECTION_REFUSED' || code === 'ECONNREFUSED') return refusalAnswer('connect-failed', { detail: 'refused' })
  if (code === 'UNREACHABLE' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return refusalAnswer('connect-failed', { detail: 'unreachable' })
  if (code === 'TIMEOUT' || code === 'ETIMEDOUT') return refusalAnswer('connect-failed', { detail: 'timeout' })
  return refusalAnswer('connect-failed', { detail: 'failed' })
}

/** The answer for a connection that was ended while it was still being made: the provider stopped, the grant went, or the destination reset it. */
const endedAnswer = (conn) => (conn.endReason === 'shutdown' ? refusalAnswer('shutting-down')
  : conn.endReason === 'revoked' ? refusalAnswer('no-grant')
    : refusalAnswer('connect-failed', { detail: 'failed' }))

/**
 * @param {object} opts
 * @param {object} opts.service - a mesh service with the protocol channel (`attachService(node, undefined, createMeshProtocolService())`, or its `.api`)
 * @param {{ checkAccess(podId: string, resource: string, action: string): (boolean|{ allowed: boolean }), onAccessChange?: Function }} opts.registry
 *   The grants are the registry's. Nothing is granted by default and no helper here creates a grant.
 * @param {(request: { host: string, port: number, wide: boolean, signal: AbortSignal, timeoutMs: number }) => Promise<{ socket: object, address: string, class: string, family?: number }>} opts.dial
 *   Resolve once, check the address, connect to the address that was checked. `./node`'s `nodeDialer` does it with wsh's guard.
 *   `wide: true` means the destination was admitted by a wildcard grant: public addresses only, whatever the operator allows for named destinations.
 *   The socket is a Node-style duplex (`on`, `write`, `end`, `destroy`, `pause`, `resume`). A dial that is an egress consumer is refused.
 * @param {(request: { name: string, wide: boolean, signal: AbortSignal, timeoutMs: number }) => Promise<Array<{ address: string, family?: number, class?: string }>>} opts.resolve
 *   The A records of a name, checked by the same policy. Rejects with the wsh guard's error codes (`NAME_NOT_FOUND`, `ADDRESS_REFUSED`, ...).
 * @param {(request: { url: string, method: string, headers: Array<[string, string]>, body: AsyncIterable<Uint8Array>|null, dial: Function, signal: AbortSignal, timeoutMs: number, maxHeaderBytes: number, headersTimeoutMs: number }) => Promise<{ status: number, statusText?: string, headers: Array<[string, string]>, body: AsyncIterable<Uint8Array> }>} [opts.exchange]
 *   The fetch form's one HTTP exchange (one request, one response head, a streamed body), made over `request.dial`, which is the checked
 *   `dial` for this hop: the connection goes to the address that was checked, and for `https:` the certificate is verified against the
 *   NAME. `./node`'s `createExchange` / `nodeDialer().exchange` does it with Node's HTTP client. Without one the provider answers
 *   the fetch form `not-offered`. It must not follow redirects, decompress, keep connections or add headers: the provider does the rest.
 * @param {string[]} [opts.fetchMethods=['GET','HEAD']] - methods a consumer may use for the fetch form (GET HEAD POST PUT PATCH DELETE OPTIONS; never CONNECT or TRACE)
 * @param {boolean} [opts.identifyConsumers=false] - add `x-browsermesh-consumer: <pod id>` to each fetch request (off: the destination never learns who asked)
 * @param {Record<string, string[]>} [opts.sets] - operator-named destination sets: `host:ports`, `*.suffix:ports`, `a.b.c.d/n:ports`
 * @param {{ acknowledge: string }} [opts.wide] - `{ acknowledge: 'any-public-address' }`: a holder of a wildcard grant may reach any public destination
 * @param {number[]} [opts.blockedPorts=[25,465,587]] - ports no one reaches (with wide mode the defaults cannot be removed)
 * @param {object} [opts.limits] - see `EGRESS_LIMIT_DEFAULTS`
 * @param {string[]|((podId: string, context: object) => (boolean|Promise<boolean>))} [opts.allowFrom] - narrows who is served beyond the registry's grants
 * @param {(destination: { peer: string, host: string, port: number }) => (boolean|Promise<boolean>)} [opts.deny] - operator veto; `true` refuses
 * @param {(info: { peer: string, bytes: Uint8Array, sig: string|undefined, request: object }) => (boolean|Promise<boolean>)} [opts.verifyRequest]
 * @param {{ connected(who: object, control: { stop(): Promise<boolean> }): void, disconnected(who: object): void }} [opts.indicator]
 * @param {boolean} [opts.unattended] - nobody is in front of this pod: allows starting without an indicator
 * @param {(record: object) => void} [opts.onAudit] - who, destination, address class, bytes, duration, outcome; never contents
 * @param {(record: object) => void} [opts.onMeter] - `{ peer, form, connections, bytesUp, bytesDown, durationMs, reason, final }`; no destination
 * @param {{ now: () => number }} [opts.clock] - the rate limiters' and byte budgets' clock (tests advance one)
 * @param {number} [opts.recheckIntervalMs=30000] - how often live connections are checked against the registry again (an expiry is noticed here)
 * @param {string} [opts.protocol='egress']
 */
export function createMeshEgress({
  service, registry, dial, resolve, exchange, dialUdp, fetchMethods = DEFAULT_FETCH_METHODS, identifyConsumers = false, auditUrls = 'none', sets, wide, blockedPorts = DEFAULT_BLOCKED_PORTS,
  blockedUdpPorts = DEFAULT_BLOCKED_UDP_PORTS, limits: limitOptions, allowFrom, deny, verifyRequest, indicator, unattended, onAudit, onMeter, clock, recheckIntervalMs = 30_000, protocol = EGRESS_PROTOCOL, onLog,
} = {}) {
  const api = service && typeof service === 'object' ? (service.api ?? service) : null
  if (typeof api?.serveProtocol !== 'function') throw new TypeError('createMeshEgress: service is a mesh service with serveProtocol (createMeshProtocolService)')
  if (!registry || typeof registry.checkAccess !== 'function') throw new TypeError('createMeshEgress: registry is required: the grants are the registry\'s')
  for (const [name, fn] of Object.entries({ dial, resolve })) {
    if (typeof fn !== 'function') throw new TypeError(`createMeshEgress: ${name} is required (a function that reaches a network; \`nodeDialer()\` from the ./node entry builds both)`)
    // A provider dials from its own network. One built on another egress would pass its consumers on (a chain).
    if (fn[EGRESS_CONSUMER]) throw new TypeError(`createMeshEgress: ${name} is an egress consumer; a provider cannot be built on another egress (chaining is refused)`)
  }
  for (const [name, fn] of Object.entries({ deny, verifyRequest, onAudit, onMeter, exchange, dialUdp })) if (fn !== undefined && typeof fn !== 'function') throw new TypeError(`createMeshEgress: ${name} must be a function`)
  for (const [name, fn] of Object.entries({ exchange, dialUdp })) if (fn?.[EGRESS_CONSUMER]) throw new TypeError(`createMeshEgress: ${name} is an egress consumer; a provider cannot be built on another egress (chaining is refused)`)
  if (!['none', 'path', 'full'].includes(auditUrls)) throw new TypeError('createMeshEgress: auditUrls is \'none\' (the default: only the length of the path), \'path\' or \'full\' (path and query)')
  if (!Array.isArray(blockedUdpPorts) || !blockedUdpPorts.every((p) => Number.isSafeInteger(p) && p >= 1 && p <= 65535)) throw new TypeError('createMeshEgress: blockedUdpPorts is a list of ports (1-65535)')
  const blockedUdp = new Set(blockedUdpPorts)
  if (!Array.isArray(fetchMethods) || !fetchMethods.length || !fetchMethods.every((m) => KNOWN_METHODS.includes(m))) throw new TypeError(`createMeshEgress: fetchMethods is a non-empty list of ${KNOWN_METHODS.join(', ')} (CONNECT and TRACE are never served)`)
  const methods = new Set(fetchMethods)
  if (typeof identifyConsumers !== 'boolean') throw new TypeError('createMeshEgress: identifyConsumers is true or false')
  if (indicator !== undefined && (typeof indicator?.connected !== 'function' || typeof indicator?.disconnected !== 'function')) throw new TypeError('createMeshEgress: indicator needs connected() and disconnected()')
  if (protocol !== EGRESS_PROTOCOL && (typeof protocol !== 'string' || !protocol)) throw new TypeError('createMeshEgress: protocol must be a name')
  if (!Number.isSafeInteger(recheckIntervalMs) || recheckIntervalMs <= 0) throw new TypeError('createMeshEgress: recheckIntervalMs must be a positive integer')
  const limits = resolveLimits(limitOptions)
  const compiled = compileSets(sets)
  if (!Array.isArray(blockedPorts) || !blockedPorts.every((p) => Number.isSafeInteger(p) && p >= 1 && p <= 65535)) throw new TypeError('createMeshEgress: blockedPorts is a list of ports (1-65535)')
  const blocked = new Set(blockedPorts)
  let wideOn = false
  if (wide !== undefined) {
    if (!wide || typeof wide !== 'object' || wide.acknowledge !== WIDE_ACKNOWLEDGEMENT) {
      throw new TypeError(`createMeshEgress: wide mode lets a holder of a wildcard grant reach any public destination; say so with wide: { acknowledge: '${WIDE_ACKNOWLEDGEMENT}' }`)
    }
    for (const p of DEFAULT_BLOCKED_PORTS) if (!blocked.has(p)) throw new TypeError(`createMeshEgress: wide mode keeps port ${p} blocked; it cannot be removed from blockedPorts while wide mode is on`)
    for (const p of DEFAULT_BLOCKED_UDP_PORTS) if (!blockedUdp.has(p)) throw new TypeError(`createMeshEgress: wide mode keeps UDP port ${p} blocked (names are looked up through the lookup form); it cannot be removed from blockedUdpPorts while wide mode is on`)
    wideOn = true
  }
  let decide = null
  if (allowFrom !== undefined) {
    if (Array.isArray(allowFrom) && allowFrom.length && allowFrom.every(isPodId)) { const set = new Set(allowFrom); decide = (p) => set.has(p) }
    else if (typeof allowFrom === 'function') {
      decide = (p, context) => {
        let verdict
        try { verdict = allowFrom(p, context) } catch { return false }
        return verdict && typeof verdict.then === 'function' ? Promise.resolve(verdict).then((v) => v === true, () => false) : verdict === true
      }
    } else throw new TypeError('createMeshEgress: allowFrom is a non-empty list of pod ids, or a function')
  }

  const now = clock?.now ?? Date.now
  const log = onLog || (() => {})
  const connectRate = createRateLimiter(limits.connectRate, { now, maxTracked: limits.maxTracked })
  const globalRate = createRateLimiter(limits.globalConnectRate, { now, maxTracked: 1 })
  const dnsRate = createRateLimiter(limits.dnsRate, { now, maxTracked: limits.maxTracked })
  const udpRate = createRateLimiter(limits.udpDatagramRate, { now, maxTracked: limits.maxTracked })
  const byteBudget = createByteBudget(limits.maxBytesPerConsumer, { now, maxTracked: limits.maxTracked })
  const inflight = createInflight({ maxTracked: limits.maxTracked })

  const channels = new Set()
  const conns = new Set()
  const perPeer = new Map() // peer -> { connections, open, bytesUp, bytesDown, refused, lookups }
  const counters = { channels: 0, requests: 0, opened: 0, refused: 0, closed: 0, lookups: 0, fetches: 0, bytesUp: 0, bytesDown: 0, reasons: {}, ends: {} }
  const udpCounters = { flows: 0, datagramsUp: 0, datagramsDown: 0, dropped: { rate: 0, credit: 0, size: 0, outbox: 0 } }
  let started = false
  let stopped = false
  let stopServing = null
  let offAccess = null
  let interval = null

  const peerStats = (peer) => {
    let s = perPeer.get(peer)
    if (!s) {
      s = { connections: 0, open: 0, bytesUp: 0, bytesDown: 0, refused: 0, lookups: 0 }
      perPeer.set(peer, s)
      if (perPeer.size > limits.maxTracked) for (const [k, v] of perPeer) { if (v.open === 0) { perPeer.delete(k); break } }
    }
    return s
  }
  const audit = (event, fields) => {
    if (!onAudit) return
    try { onAudit({ event, at: now(), ...fields }) } catch { /* an audit sink never breaks a connection */ }
  }
  const meter = (record) => {
    if (!onMeter) return
    try { onMeter(record) } catch { /* a meter never breaks a connection */ }
  }
  const can = (peer, resource, action) => {
    try { const r = registry.checkAccess(peer, resource, action); return r === true || r?.allowed === true } catch { return false }
  }

  // ----------------------------------------------------------- the grant for a destination
  /**
   * Which grant admits this destination, or why none does. The literal-`*` forms are asked first: the registry matches a
   * literal `*` only against a wildcard scope, so these detect exactly the wildcard grants. A holder of one is refused
   * `wide-not-acknowledged` unless the operator acknowledged wide mode, even if an exact grant would also cover the request.
   */
  function authorise(peer, host, kind, port, form = 'tcp') {
    // One rule for every form; only the scope family and the action differ: `egress:tcp:..:connect`, `egress:http:..:fetch`, `egress:udp:..:send`.
    const { family, action } = FORMS[form]
    const wild = () => can(peer, `egress:${family}:*:*`, action) || can(peer, `egress:${family}:*:${port}`, action)
    if (wild()) return wideOn ? { ok: true, via: 'wide', still: wild } : { ok: false, code: 'wide-not-acknowledged' }
    if (can(peer, `egress:${family}:${host}:${port}`, action)) return { ok: true, via: 'exact', still: () => can(peer, `egress:${family}:${host}:${port}`, action) }
    if (can(peer, `egress:${family}:${host}:*`, action)) return { ok: true, via: 'host', still: () => can(peer, `egress:${family}:${host}:*`, action) }
    for (const name of setsCovering(compiled, host, kind, port)) {
      if (can(peer, `egress:set:${name}`, action)) return { ok: true, via: 'set', set: name, still: () => can(peer, `egress:set:${name}`, action) }
    }
    return { ok: false, code: 'no-grant' }
  }

  function authoriseResolve(peer, name) {
    if (can(peer, 'egress:dns:*', 'resolve')) return wideOn ? { ok: true, via: 'wide' } : { ok: false, code: 'wide-not-acknowledged' }
    if (can(peer, `egress:dns:${name}`, 'resolve')) return { ok: true, via: 'exact' }
    return { ok: false, code: 'no-grant' }
  }

  // ----------------------------------------------------------- one connection's life
  function endConnection(conn, reason, { notify = true } = {}) {
    if (conn.ended) return
    conn.ended = true
    conn.endReason = reason
    clearTimeout(conn.idleTimer)
    clearTimeout(conn.durationTimer)
    clearTimeout(conn.upTimer)
    clearInterval(conn.meterTimer)
    conns.delete(conn)
    conn.chan.conns.delete(conn.cid)
    try { conn.ac.abort(new Error(reason)) } catch { /* already aborted */ }
    try { if (conn.form === 'udp') conn.socket?.close(); else conn.socket?.destroy() } catch { /* already closed */ }
    try { conn.upReady?.reject(new Error(reason)) } catch { /* settled */ }
    if (reason !== 'closed') {
      if (notify) { try { Promise.resolve(conn.chan.channel.notify(END_METHOD, { cid: conn.cid, reason })).catch(() => {}) } catch { /* channel gone */ } }
      try { conn.down?.abort(reason) } catch { /* gone */ }
    }
    try { conn.up?.cancel(reason).catch(() => {}) } catch { /* gone */ }
    conn.releases.splice(0).forEach((r) => r())
    if (conn.opened) {
      counters.closed += 1
      counters.ends[reason] = (counters.ends[reason] ?? 0) + 1
      peerStats(conn.peer).open -= 1
      audit('egress-close', { outcome: 'closed', peer: conn.peer, form: conn.form, ...fetchFields(conn), ...udpFields(conn), host: conn.host, port: conn.port, address: conn.address, addressClass: conn.addressClass, bytesUp: conn.bytesUp, bytesDown: conn.bytesDown, durationMs: Math.max(0, now() - conn.startedAt), reason })
      emitMeter(conn, true, reason)
      try { indicator?.disconnected({ peer: conn.peer, host: conn.host, port: conn.port }) } catch { /* the embedder's callback */ }
    }
  }

  /** What the audit adds for the fetch form: the method, how long the path was, the final status and the redirects followed. Never the path itself. */
  const fetchFields = (conn) => (conn.form === 'fetch' ? { method: conn.method, ...urlFields(conn.target), status: conn.status, redirects: conn.redirects } : {})
  /** What the audit adds for a UDP flow: datagrams each way, and the datagrams dropped on the way in and the way out. Never a payload. */
  const udpFields = (conn) => (conn.form === 'udp' ? { datagramsUp: conn.datagramsUp, datagramsDown: conn.datagramsDown, droppedUp: conn.droppedUp, droppedDown: conn.droppedDown } : {})
  /** What the audit says of a URL: the length of its path and query, and, only if the operator chose `auditUrls`, the path (`'path'`) and the query (`'full'`). */
  function urlFields(t) {
    if (!t) return {}
    const out = { pathLength: t.pathLength }
    if (auditUrls !== 'none') out.path = t.url.pathname
    if (auditUrls === 'full' && t.url.search) out.query = t.url.search.slice(1)
    return out
  }

  function emitMeter(conn, final, reason) {
    const bytesUp = conn.bytesUp - conn.meteredUp
    const bytesDown = conn.bytesDown - conn.meteredDown
    conn.meteredUp = conn.bytesUp
    conn.meteredDown = conn.bytesDown
    meter({ peer: conn.peer, form: conn.form, connections: final ? 1 : 0, bytesUp, bytesDown, durationMs: Math.max(0, now() - conn.startedAt), reason: final ? reason : undefined, final })
  }

  /** Count bytes against the connection's and the consumer's budgets; returns false (after ending the connection) when one is spent. */
  function account(conn, direction, n) {
    if (conn.ended) return false
    if (direction === 'up') { conn.bytesUp += n; counters.bytesUp += n; peerStats(conn.peer).bytesUp += n } else { conn.bytesDown += n; counters.bytesDown += n; peerStats(conn.peer).bytesDown += n }
    if (conn.bytesUp + conn.bytesDown > limits.maxBytesPerConnection) { endConnection(conn, 'byte-budget'); return false }
    if (!byteBudget.add(conn.peer, n)) { endConnection(conn, 'consumer-budget'); return false }
    touch(conn)
    return true
  }

  function touch(conn) {
    if (conn.ended) return
    clearTimeout(conn.idleTimer)
    conn.idleTimer = unref(setTimeout(() => endConnection(conn, 'idle'), conn.form === 'udp' ? limits.udpIdleMs : limits.idleMs))
  }

  /** Origin to consumer: one chunk at a time, the origin paused until the stream has taken it (credit-paced). */
  function pumpDown(conn) {
    const { socket, down } = conn
    socket.on('data', (chunk) => {
      if (conn.ended) return
      if (!account(conn, 'down', chunk.byteLength)) return
      socket.pause()
      down.write(new Uint8Array(chunk)).then(() => { if (!conn.ended) socket.resume() }, () => endConnection(conn, 'consumer-left'))
    })
    socket.on('end', () => {
      conn.originEnded = true
      down.end().then(() => { if (conn.upDone) endConnection(conn, 'closed') }, () => endConnection(conn, 'consumer-left'))
    })
  }

  /** Consumer to origin: the stream's credit is returned as each chunk is written, so a slow origin slows the consumer. */
  async function pumpUp(conn) {
    const { socket, up } = conn
    try {
      for (;;) {
        const { done, value } = await up.read()
        if (done) break
        if (conn.ended) return
        if (!account(conn, 'up', value.byteLength)) return
        if (!socket.write(value)) await new Promise((resolve) => { const fn = () => { socket.off?.('drain', fn); socket.off?.('close', fn); resolve() }; socket.once('drain', fn); socket.once('close', fn) })
      }
    } catch (e) {
      if (!conn.ended) endConnection(conn, ['stream-abuse', 'stream-violation', 'stream-too-large'].includes(e?.reason) ? 'stream-abuse' : 'consumer-left')
      return
    }
    conn.upDone = true
    if (conn.ended) return
    try { socket.end() } catch { /* closed */ }
    if (conn.originEnded) endConnection(conn, 'closed')
  }

  /**
   * Origin to consumer for the fetch form: the response body is pulled one chunk at a time and written to the stream, which waits for
   * the consumer's credit, so a consumer that stops reading stops the origin. Ends the connection when the body is complete.
   */
  async function pumpResponse(conn, body) {
    try {
      if (body) {
        for await (const chunk of body) {
          if (conn.ended) return
          if (!account(conn, 'down', chunk.byteLength)) return
          try { await conn.down.write(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)) } catch (e) { throw Object.assign(new Error('consumer'), { consumerLeft: true, cause: e }) }
        }
      }
    } catch (e) {
      if (!conn.ended) endConnection(conn, e?.consumerLeft ? 'consumer-left' : 'origin-error')
      return
    }
    if (conn.ended) return
    try { await conn.down.end() } catch { endConnection(conn, 'consumer-left'); return }
    endConnection(conn, 'closed')
  }

  // ----------------------------------------------------------- UDP: datagrams as frames
  /** Count a datagram seen in either direction (dropped ones too) against the flow's datagram budget; ends the flow when it is spent. */
  function seenDatagram(conn) {
    conn.datagramsSeen += 1
    if (conn.datagramsSeen > limits.maxUdpDatagramsPerFlow) { endConnection(conn, 'datagram-budget'); return false }
    return true
  }

  /** Count a datagram that is going on against the flow's and the consumer's byte budgets. */
  function accountDatagram(conn, direction, n) {
    if (conn.ended) return false
    if (direction === 'up') { conn.datagramsUp += 1; conn.bytesUp += n; udpCounters.datagramsUp += 1; counters.bytesUp += n; peerStats(conn.peer).bytesUp += n } else {
      conn.datagramsDown += 1; conn.bytesDown += n; udpCounters.datagramsDown += 1; counters.bytesDown += n; peerStats(conn.peer).bytesDown += n
    }
    if (conn.bytesUp + conn.bytesDown > limits.maxUdpBytesPerFlow) { endConnection(conn, 'byte-budget'); return false }
    if (!byteBudget.add(conn.peer, n)) { endConnection(conn, 'consumer-budget'); return false }
    touch(conn)
    return true
  }

  const dropped = (conn, direction, why) => {
    if (direction === 'up') conn.droppedUp += 1; else conn.droppedDown += 1
    udpCounters.dropped[why] += 1
  }

  /**
   * Consumer to destination: the stream's chunks are cut into datagrams (a frame may be split across chunks), each is bounded in
   * size, counted, rate-limited (over the rate it is dropped, as a network would) and sent on the connected socket. Each datagram
   * the consumer sends earns the flow credit for replies.
   */
  async function pumpDatagramsUp(conn) {
    const { socket, up } = conn
    const frames = createFrameReader(limits.maxDatagramBytes)
    try {
      for (;;) {
        const { done, value } = await up.read()
        if (done) break
        if (conn.ended) return
        let datagrams
        try { datagrams = frames.push(value) } catch { endConnection(conn, 'stream-abuse'); return }
        for (const payload of datagrams) {
          if (conn.ended || !seenDatagram(conn)) return
          if (!udpRate.take(conn.peer).ok) { dropped(conn, 'up', 'rate'); continue }
          if (!accountDatagram(conn, 'up', payload.byteLength)) return
          conn.replyCredit = Math.min(limits.udpReplyCreditMaxBytes, conn.replyCredit + Math.max(limits.udpReplyFloorBytes, payload.byteLength * limits.udpReplyRatio))
          // One at a time: the next frame is not read until the socket has taken this one, so a slow network slows the consumer.
          await new Promise((resolve) => { try { socket.send(payload, () => resolve()) } catch { resolve() } })
        }
      }
    } catch (e) {
      if (!conn.ended) endConnection(conn, ['stream-abuse', 'stream-violation', 'stream-too-large'].includes(e?.reason) ? 'stream-abuse' : 'consumer-left')
      return
    }
    // A flow has no half-close: the consumer finishing its sending ends it.
    if (!conn.ended) endConnection(conn, 'closed')
  }

  /**
   * Destination to consumer: a reply is passed on only if it fits the datagram bound, the credit the consumer's own sends earned, the
   * rate and the outbox; otherwise it is dropped and counted. Nothing is truncated or split.
   */
  function onReply(conn, message) {
    if (conn.ended || !conn.opened || !seenDatagram(conn)) return
    const n = message.byteLength
    if (n > limits.maxDatagramBytes) return dropped(conn, 'down', 'size')
    if (n > conn.replyCredit) return dropped(conn, 'down', 'credit')
    if (!udpRate.take(conn.peer).ok) return dropped(conn, 'down', 'rate')
    if (conn.outboxBytes + n + 2 > limits.udpOutboxBytes) return dropped(conn, 'down', 'outbox')
    conn.replyCredit -= n
    if (!accountDatagram(conn, 'down', n)) return
    const frame = encodeDatagram(new Uint8Array(message.buffer, message.byteOffset, n))
    conn.outboxBytes += frame.byteLength
    conn.outbox = conn.outbox.then(() => (conn.ended ? undefined : conn.down.write(frame))).then(() => { conn.outboxBytes -= frame.byteLength }, () => endConnection(conn, 'consumer-left'))
  }

  // ----------------------------------------------------------- one channel (one consumer)
  function accept(channel, { peer, version }) {
    const context = { peer, protocol, version }
    if (stopped || !started) { channel.close('not serving'); return }
    const first = decide ? decide(peer, context) : true
    let open = typeof first === 'boolean' ? first : null
    const chan = { channel, peer, conns: new Map(), bad: 0, streams: null }
    const refuseChannel = () => { open = false; channels.delete(chan); channel.close('not an egress consumer this pod serves') }
    if (open === false) { channel.close('not an egress consumer this pod serves'); return }
    counters.channels += 1
    channels.add(chan)
    if (open === null) first.then((ok) => { if (ok) open = true; else refuseChannel() })

    const badRequest = (why) => {
      chan.bad += 1
      if (chan.bad > limits.maxBadRequests) {
        audit('egress-abuse', { outcome: 'closed', peer, reason: 'bad-requests' })
        log('egress:too-many-bad-requests', { peer, why })
        channel.close('too many malformed requests')
      }
    }
    chan.streams = createStreamLayer(channel, {
      maxStreams: limits.maxConnectionsPerConsumer * 2,
      window: limits.streamWindowBytes,
      // A belt over the braces: the connection's own byte accounting (which says why) ends it first; a stream gets room for what was in flight.
      maxStreamBytes: limits.maxBytesPerConnection + 2 * limits.streamWindowBytes,
      maxViolations: limits.maxViolations,
      onAbuse: (reason) => {
        audit('egress-abuse', { outcome: 'closed', peer, reason: 'stream-abuse' })
        for (const conn of [...chan.conns.values()]) endConnection(conn, 'stream-abuse')
        try { channel.close('stream rules broken') } catch { /* gone */ }
      },
      onLog,
    })

    chan.streams.onStream((reader, { meta }) => {
      try { validateStreamMeta(meta, KIND_UP) } catch (e) { badRequest('stream'); throw new MeshChannelError(ChannelErrorCode.INVALID, 'bad-stream', e.message) }
      const conn = chan.conns.get(meta.cid)
      if (open === false || !conn || conn.ended || conn.state !== 'awaiting-up' || conn.up) {
        badRequest('stream')
        throw new MeshChannelError(ChannelErrorCode.INVALID, 'bad-stream', 'no connection of yours is waiting for that stream')
      }
      clearTimeout(conn.upTimer)
      conn.up = reader
      conn.state = 'open'
      // A fetch request's body is read by the exchange as it sends; a TCP connection's by the relay to the socket; a UDP flow's as datagram frames.
      if (conn.upReady) conn.upReady.resolve(reader)
      else if (conn.form === 'udp') pumpDatagramsUp(conn)
      else pumpUp(conn)
    })

    const refuse = (req, form, answer, extra = {}) => {
      counters.refused += 1
      counters.reasons[answer.code] = (counters.reasons[answer.code] ?? 0) + 1
      peerStats(peer).refused += 1
      audit('egress-refused', { outcome: 'refused', peer, form, host: text(req.host ?? req.name), port: Number.isSafeInteger(req.port) ? req.port : undefined, code: answer.code, budget: answer.budget, addressClass: answer.addressClass, detail: answer.detail, ...extra })
      return answer
    }

    /** The checks every request meets before anything about a destination is looked at. Returns a refusal answer, or null. */
    async function admit(params, form, validate) {
      let req
      try { req = validate(params) } catch (e) {
        badRequest(form)
        return { req: params && typeof params === 'object' ? params : {}, answer: refusalAnswer(e instanceof EgressError ? e.code : 'bad-request') }
      }
      if (stopped) return { req, answer: refusalAnswer('shutting-down') }
      if (req.hops !== 0) return { req, answer: refusalAnswer('chaining-refused') }
      if (open === false || (open === null && !(await first))) return { req, answer: refusalAnswer('no-grant') }
      // Asked again for every request, so a function that stops saying yes stops the next request.
      if (decide && (await decide(peer, context)) !== true) return { req, answer: refusalAnswer('no-grant') }
      return { req, answer: null }
    }

    async function verified(req, form, dest = req) {
      if (!verifyRequest) return true
      const host = dest.host ?? dest.name
      const bytes = signedRequestBytes({ form, cid: req.cid, nonce: req.nonce, host, port: dest.port })
      try { return (await verifyRequest({ peer, bytes, sig: req.sig, request: { form, cid: req.cid, host, port: dest.port } })) === true } catch { return false }
    }

    // ---- connect
    channel.onRequest(CONNECT_METHOD, async (params) => {
      counters.requests += 1
      const { req, answer: early } = await admit(params, 'tcp', validateConnect)
      if (early) return refuse(req, 'tcp', early)
      if (!connectRate.take(peer).ok) return refuse(req, 'tcp', refusalAnswer('budget-exceeded', { budget: 'connect-rate' }))
      if (!globalRate.take('*').ok) return refuse(req, 'tcp', refusalAnswer('budget-exceeded', { budget: 'connect-rate-global' }))
      const grant = authorise(peer, req.host, req.kind, req.port)
      if (!grant.ok) return refuse(req, 'tcp', refusalAnswer(grant.code))
      if (!(await verified(req, 'connect'))) return refuse(req, 'tcp', refusalAnswer('bad-request'), { detail: 'request-unverified' })
      if (blocked.has(req.port)) return refuse(req, 'tcp', refusalAnswer('port-blocked'))
      if (deny) {
        let vetoed
        try { vetoed = (await deny({ peer, host: req.host, port: req.port })) === true } catch { vetoed = true }
        if (vetoed) return refuse(req, 'tcp', refusalAnswer('destination-refused'))
      }
      if (chan.conns.has(req.cid)) { badRequest('cid'); return refuse(req, 'tcp', refusalAnswer('bad-request')) }
      if (byteBudget.spent(peer)) return refuse(req, 'tcp', refusalAnswer('budget-exceeded', { budget: 'bytes-per-consumer' }))
      const releases = []
      const mine = inflight.enter(`p:${peer}`, limits.maxConnectionsPerConsumer)
      if (!mine) return refuse(req, 'tcp', refusalAnswer('budget-exceeded', { budget: 'connections-per-consumer' }))
      releases.push(mine)
      const all = inflight.enter('*', limits.maxConnections)
      if (!all) { mine(); return refuse(req, 'tcp', refusalAnswer('budget-exceeded', { budget: 'connections-global' })) }
      releases.push(all)

      const conn = {
        cid: req.cid, form: 'tcp', peer, chan, host: req.host, port: req.port, via: grant.via, still: grant.still, ac: new AbortController(), releases, state: 'dialing',
        socket: null, up: null, down: null, address: undefined, addressClass: undefined, startedAt: now(), opened: false, ended: false,
        bytesUp: 0, bytesDown: 0, meteredUp: 0, meteredDown: 0, originEnded: false, upDone: false,
      }
      chan.conns.set(conn.cid, conn)
      conns.add(conn)
      try {
        const timeoutMs = limits.connectTimeoutMs
        const guard = deferred()
        const timer = unref(setTimeout(() => { conn.ac.abort(new Error('connect timeout')); guard.reject(Object.assign(new Error('connect timed out'), { code: 'TIMEOUT' })) }, timeoutMs))
        let dialed
        try { dialed = await Promise.race([dial({ host: conn.host, port: conn.port, wide: grant.via === 'wide', signal: conn.ac.signal, timeoutMs }), guard.promise]) } finally { clearTimeout(timer) }
        if (!dialed || typeof dialed !== 'object' || !dialed.socket || typeof dialed.socket.on !== 'function') throw Object.assign(new Error('dial returned no socket'), { code: 'FAILED' })
        conn.socket = dialed.socket
        // Listened to from the moment it exists: a destination that resets before the answer must end the connection, never go unheard.
        conn.socket.on('error', () => endConnection(conn, 'origin-error'))
        conn.socket.on('close', () => endConnection(conn, conn.originEnded ? 'closed' : 'origin-error'))
        conn.address = text(dialed.address, 64)
        conn.addressClass = text(dialed.class, 32)
        if (conn.ended) { conn.socket.destroy(); return refuse(req, 'tcp', endedAnswer(conn), { detail: conn.endReason }) }
        // Wide mode is public addresses only, whatever a dial was configured to allow for named destinations.
        if (grant.via === 'wide' && dialed.class !== 'public') {
          endConnection(conn, 'closed')
          return refuse(req, 'tcp', refusalAnswer('destination-refused', { addressClass: conn.addressClass }), { address: conn.address })
        }
        // Tell the consumer's reader about the answer's streams in the right order: the down stream opens BEFORE the answer.
        conn.down = await chan.streams.open({ cid: conn.cid, kind: KIND_DOWN }, { signal: conn.ac.signal, timeoutMs: limits.upWaitMs })
        if (conn.ended) return refuse(req, 'tcp', endedAnswer(conn), { detail: conn.endReason })
      } catch (e) {
        const answer = conn.ended && ['revoked', 'shutdown'].includes(conn.endReason) ? endedAnswer(conn) : refusalOf(e, 'dial')
        endConnection(conn, 'closed')
        return refuse(req, 'tcp', answer, { address: conn.address })
      }
      conn.opened = true
      conn.state = 'awaiting-up'
      counters.opened += 1
      peerStats(peer).connections += 1
      peerStats(peer).open += 1
      conn.upTimer = unref(setTimeout(() => endConnection(conn, 'up-timeout'), limits.upWaitMs))
      conn.durationTimer = unref(setTimeout(() => endConnection(conn, 'time-budget'), limits.maxDurationMs))
      conn.meterTimer = unref(setInterval(() => emitMeter(conn, false), limits.meterIntervalMs))
      touch(conn)
      pumpDown(conn)
      audit('egress-open', { outcome: 'opened', peer, form: 'tcp', host: conn.host, port: conn.port, address: conn.address, addressClass: conn.addressClass, via: conn.via })
      try {
        indicator?.connected({ peer, host: conn.host, port: conn.port }, { stop: async () => { endConnection(conn, 'shutdown'); return true } })
      } catch { /* the embedder's callback */ }
      return { ok: true }
    })

    // ---- fetch: the provider is the HTTP client. It sees the whole request and the whole response.
    channel.onRequest(FETCH_METHOD, async (params, ctx) => {
      counters.requests += 1
      let req
      try { req = validateFetch(params, { maxHeaderBytes: limits.maxHeaderBytes }) } catch (e) {
        badRequest('fetch')
        return refuse({}, 'fetch', refusalAnswer(e instanceof EgressError ? e.code : 'bad-request'))
      }
      const view = { host: req.target?.host, port: req.target?.port }
      const about = { method: req.method, ...urlFields(req.target) }
      // Registered before anything is awaited: the consumer sends a request body's stream right behind the request, and it must find this.
      let conn = null
      if (req.hops === 0) {
        if (chan.conns.has(req.cid) || chan.conns.size >= limits.maxConnectionsPerConsumer * 2) { badRequest('cid'); return refuse(view, 'fetch', refusalAnswer('bad-request'), about) }
        conn = {
          cid: req.cid, form: 'fetch', peer, chan, host: req.target.host, port: req.target.port, via: undefined, stills: [], ac: new AbortController(), releases: [], state: req.body ? 'awaiting-up' : 'dialing',
          socket: null, up: null, down: null, address: undefined, addressClass: undefined, startedAt: now(), opened: false, ended: false, bytesUp: 0, bytesDown: 0, meteredUp: 0, meteredDown: 0,
          method: req.method, target: req.target, status: undefined, redirects: 0, upReady: req.body ? deferred() : null,
        }
        conn.still = () => conn.stills.every((f) => f())
        // The consumer cancelling the request (its signal aborted before the answer) ends it now, whatever it is doing.
        ctx?.signal?.addEventListener('abort', () => { if (!conn.opened) endConnection(conn, 'consumer-left') }, { once: true })
        chan.conns.set(conn.cid, conn)
        conns.add(conn)
        if (req.body) conn.upTimer = unref(setTimeout(() => endConnection(conn, 'up-timeout'), limits.upWaitMs))
      }
      let headersTimer = null
      const drop = (answer, extra = {}, target = view) => {
        clearTimeout(headersTimer)
        if (conn) endConnection(conn, 'closed')
        return refuse(target, 'fetch', answer, { ...about, ...extra })
      }
      const { answer: early } = await admit(params, 'fetch', () => req)
      if (early) return drop(early)
      if (!connectRate.take(peer).ok) return drop(refusalAnswer('budget-exceeded', { budget: 'connect-rate' }))
      if (!globalRate.take('*').ok) return drop(refusalAnswer('budget-exceeded', { budget: 'connect-rate-global' }))
      let grant = authorise(peer, req.target.host, req.target.kind, req.target.port, 'fetch')
      if (!grant.ok) return drop(refusalAnswer(grant.code))
      if (!methods.has(req.method)) return drop(refusalAnswer('method-not-allowed'))
      if (!(await verified(req, 'fetch', { host: req.target.host, port: req.target.port }))) return drop(refusalAnswer('bad-request'), { detail: 'request-unverified' })
      /** The operator's blocked ports and veto, for one hop. */
      const vetoed = async (t) => {
        if (blocked.has(t.port)) return refusalAnswer('port-blocked')
        if (deny) {
          let no
          try { no = (await deny({ peer, host: t.host, port: t.port })) === true } catch { no = true }
          if (no) return refusalAnswer('destination-refused')
        }
        return null
      }
      const veto = await vetoed(req.target)
      if (veto) return drop(veto)
      if (!exchange) return drop(refusalAnswer('not-offered'))
      if (byteBudget.spent(peer)) return drop(refusalAnswer('budget-exceeded', { budget: 'bytes-per-consumer' }))
      const mine = inflight.enter(`p:${peer}`, limits.maxConnectionsPerConsumer)
      if (!mine) return drop(refusalAnswer('budget-exceeded', { budget: 'connections-per-consumer' }))
      conn.releases.push(mine)
      const all = inflight.enter('*', limits.maxConnections)
      if (!all) return drop(refusalAnswer('budget-exceeded', { budget: 'connections-global' }))
      conn.releases.push(all)
      conn.via = grant.via
      conn.stills.push(grant.still)
      counters.fetches += 1
      conn.durationTimer = unref(setTimeout(() => endConnection(conn, 'time-budget'), limits.maxDurationMs))
      touch(conn)
      headersTimer = unref(setTimeout(() => { conn.headersTimedOut = true; try { conn.ac.abort(new Error('headers timeout')) } catch { /* aborted */ } }, limits.headersTimeoutMs))

      /** The request body, read from the consumer's stream as the exchange sends it (the stream's credit is its backpressure). */
      let bodySource = null
      if (req.body) {
        bodySource = (async function* upload() {
          const up = await conn.upReady.promise
          try {
            for (;;) {
              const { done, value } = await up.read()
              if (done) break
              if (conn.ended) return
              if (!account(conn, 'up', value.byteLength)) return
              yield value
            }
            conn.upDone = true
          } catch (e) {
            if (!conn.ended) endConnection(conn, ['stream-abuse', 'stream-violation', 'stream-too-large'].includes(e?.reason) ? 'stream-abuse' : 'consumer-left')
          }
        })()
      }

      let target = req.target
      let method = req.method
      let headers = req.headers
      let resp
      try {
        for (let hop = 0; ; hop += 1) {
          const sameOrigin = hop === 0 || originOf(target) === conn.firstOrigin
          if (hop === 0) conn.firstOrigin = originOf(target)
          const outgoing = requestHeaders(headers, { keepAuthorization: sameOrigin })
          outgoing.push(['host', target.port === (target.secure ? 443 : 80) ? target.host : `${target.host}:${target.port}`], ['user-agent', FETCH_USER_AGENT], ['accept-encoding', 'identity'], ['connection', 'close'])
          if (identifyConsumers) outgoing.push([CONSUMER_HEADER, peer])
          const wideHop = grant.via === 'wide'
          const checkedDial = async (d) => {
            const dialed = await dial({ host: d.host, port: d.port, wide: wideHop, signal: conn.ac.signal, timeoutMs: d.timeoutMs ?? limits.connectTimeoutMs })
            if (!dialed || typeof dialed !== 'object' || !dialed.socket || typeof dialed.socket.on !== 'function') throw Object.assign(new Error('dial returned no socket'), { code: 'FAILED' })
            conn.address = text(dialed.address, 64)
            conn.addressClass = text(dialed.class, 32)
            if (wideHop && dialed.class !== 'public') {
              try { dialed.socket.destroy() } catch { /* closed */ }
              throw Object.assign(new Error('refused'), { code: 'ADDRESS_REFUSED', refused: [{ class: dialed.class }] })
            }
            return dialed
          }
          conn.host = target.host
          conn.port = target.port
          conn.target = target
          resp = await exchange({
            url: target.href, method, headers: outgoing, body: bodySource, dial: checkedDial, signal: conn.ac.signal,
            timeoutMs: limits.connectTimeoutMs, maxHeaderBytes: limits.maxHeaderBytes, headersTimeoutMs: limits.headersTimeoutMs,
          })
          if (conn.ended) throw Object.assign(new Error('ended'), { code: 'ENDED' })
          if (!resp || !Number.isSafeInteger(resp.status) || !Array.isArray(resp.headers) || !resp.body) throw Object.assign(new Error('exchange returned no response'), { code: 'BAD_RESPONSE' })
          if (resp.headers.length > MAX_HEADERS || headerBytes(resp.headers) > limits.maxHeaderBytes) throw Object.assign(new Error('the response head is too large'), { code: 'BAD_RESPONSE' })
          conn.status = resp.status
          audit('egress-hop', { outcome: 'hop', peer, form: 'fetch', hop, method, host: target.host, port: target.port, address: conn.address, addressClass: conn.addressClass, ...urlFields(target), status: resp.status, via: grant.via })
          const location = req.redirect === 'follow' && REDIRECT_STATUSES.includes(resp.status) ? resp.headers.find(([k]) => String(k).toLowerCase() === 'location')?.[1] : undefined
          if (location === undefined) break
          // A redirect: the next destination is judged exactly as the first was, by the same rules, before anything is dialled.
          try { resp.destroy?.() } catch { /* nothing to drain */ }
          if (hop >= limits.maxRedirects) return drop(refusalAnswer('too-many-redirects'))
          let next
          try { next = parseTarget(String(location), target.href) } catch { return drop(refusalAnswer('redirect-refused'), { hop: hop + 1 }) }
          const nextView = { host: next.host, port: next.port }
          if (target.secure && !next.secure) return drop(refusalAnswer('redirect-refused'), { hop: hop + 1, detail: 'downgrade' }, nextView)
          if (method === 'POST' && (resp.status === 301 || resp.status === 302) || (resp.status === 303 && method !== 'HEAD')) { method = 'GET'; headers = headers.filter(([k]) => k !== 'content-type' && k !== 'content-length'); if (bodySource) { bodySource = null; conn.up?.cancel('redirected').catch(() => {}) } }
          else if (bodySource) return drop(refusalAnswer('redirect-refused'), { hop: hop + 1, detail: 'body' }, nextView)
          const nextGrant = authorise(peer, next.host, next.kind, next.port, 'fetch')
          if (!nextGrant.ok) return drop(refusalAnswer(nextGrant.code === 'no-grant' ? 'redirect-refused' : nextGrant.code), { hop: hop + 1 }, nextView)
          const nextVeto = await vetoed(next)
          if (nextVeto) return drop(nextVeto, { hop: hop + 1 }, nextView)
          if (conn.ended) throw Object.assign(new Error('ended'), { code: 'ENDED' })
          grant = nextGrant
          conn.stills.push(grant.still)
          conn.redirects = hop + 1
          target = next
        }
        clearTimeout(headersTimer)
        const answerHeaders = responseHeaders(resp.headers, { maxBytes: limits.maxHeaderBytes })
        const statusText = typeof resp.statusText === 'string' && resp.statusText.length <= 64 && /^[\t\x20-\x7e]*$/.test(resp.statusText) ? resp.statusText : ''
        // The answer's streams: the response body's opens BEFORE the answer, as a TCP connection's does.
        conn.down = await chan.streams.open({ cid: conn.cid, kind: KIND_DOWN }, { signal: conn.ac.signal, timeoutMs: limits.upWaitMs })
        if (conn.ended) return drop(endedAnswer(conn), { detail: conn.endReason })
        // The consumer cancelling its reader (it dropped the Response body) ends the fetch at once, not at the next chunk.
        conn.down.signal.addEventListener('abort', () => { if (!conn.ended) endConnection(conn, 'consumer-left') }, { once: true })
        conn.opened = true
        conn.state = 'open'
        counters.opened += 1
        peerStats(peer).connections += 1
        peerStats(peer).open += 1
        audit('egress-open', { outcome: 'opened', peer, form: 'fetch', method, host: target.host, port: target.port, address: conn.address, addressClass: conn.addressClass, via: grant.via, ...urlFields(target), status: resp.status, redirects: conn.redirects })
        try { indicator?.connected({ peer, host: conn.host, port: conn.port, form: 'fetch' }, { stop: async () => { endConnection(conn, 'shutdown'); return true } }) } catch { /* the embedder's callback */ }
        conn.meterTimer = unref(setInterval(() => emitMeter(conn, false), limits.meterIntervalMs))
        const noBody = method === 'HEAD' || NO_BODY_STATUSES.includes(resp.status)
        pumpResponse(conn, noBody ? null : resp.body)
        return { ok: true, status: resp.status, statusText, headers: answerHeaders, url: target.href, redirected: conn.redirects > 0 }
      } catch (e) {
        clearTimeout(headersTimer)
        const answer = conn.ended && ['revoked', 'shutdown'].includes(conn.endReason) ? endedAnswer(conn)
          : conn.headersTimedOut ? refusalAnswer('connect-failed', { detail: 'timeout' })
            : e?.code === 'CERTIFICATE' ? refusalAnswer('connect-failed', { detail: 'certificate' })
              : e?.code === 'BAD_RESPONSE' || e instanceof EgressError && e.code === 'bad-response' ? refusalAnswer('bad-response')
                : conn.ended ? endedAnswer(conn) : refusalOf(e, 'dial')
        return drop(answer, { address: conn.address })
      }
    })

    // ---- udp: one flow to one destination, over a datagram socket connected to the address that was checked
    channel.onRequest(UDP_METHOD, async (params) => {
      counters.requests += 1
      const { req, answer: early } = await admit(params, 'udp', validateConnect)
      if (early) return refuse(req, 'udp', early)
      if (!connectRate.take(peer).ok) return refuse(req, 'udp', refusalAnswer('budget-exceeded', { budget: 'connect-rate' }))
      if (!globalRate.take('*').ok) return refuse(req, 'udp', refusalAnswer('budget-exceeded', { budget: 'connect-rate-global' }))
      const grant = authorise(peer, req.host, req.kind, req.port, 'udp')
      if (!grant.ok) return refuse(req, 'udp', refusalAnswer(grant.code))
      if (!(await verified(req, 'udp'))) return refuse(req, 'udp', refusalAnswer('bad-request'), { detail: 'request-unverified' })
      // DNS is its own form, with its own grant and rate: no grant, wide mode included, talks to a resolver over UDP.
      if (blockedUdp.has(req.port)) return refuse(req, 'udp', refusalAnswer('port-blocked'))
      if (deny) {
        let vetoed
        try { vetoed = (await deny({ peer, host: req.host, port: req.port })) === true } catch { vetoed = true }
        if (vetoed) return refuse(req, 'udp', refusalAnswer('destination-refused'))
      }
      if (!dialUdp) return refuse(req, 'udp', refusalAnswer('not-offered'))
      if (chan.conns.has(req.cid)) { badRequest('cid'); return refuse(req, 'udp', refusalAnswer('bad-request')) }
      if (byteBudget.spent(peer)) return refuse(req, 'udp', refusalAnswer('budget-exceeded', { budget: 'bytes-per-consumer' }))
      const releases = []
      const flows = inflight.enter(`u:${peer}`, limits.maxUdpFlowsPerConsumer)
      if (!flows) return refuse(req, 'udp', refusalAnswer('budget-exceeded', { budget: 'udp-flows-per-consumer' }))
      releases.push(flows)
      const mine = inflight.enter(`p:${peer}`, limits.maxConnectionsPerConsumer)
      if (!mine) { flows(); return refuse(req, 'udp', refusalAnswer('budget-exceeded', { budget: 'connections-per-consumer' })) }
      releases.push(mine)
      const all = inflight.enter('*', limits.maxConnections)
      if (!all) { flows(); mine(); return refuse(req, 'udp', refusalAnswer('budget-exceeded', { budget: 'connections-global' })) }
      releases.push(all)

      const conn = {
        cid: req.cid, form: 'udp', peer, chan, host: req.host, port: req.port, via: grant.via, still: grant.still, ac: new AbortController(), releases, state: 'dialing',
        socket: null, up: null, down: null, address: undefined, addressClass: undefined, startedAt: now(), opened: false, ended: false,
        bytesUp: 0, bytesDown: 0, meteredUp: 0, meteredDown: 0, originEnded: false, upDone: false,
        datagramsUp: 0, datagramsDown: 0, droppedUp: 0, droppedDown: 0, datagramsSeen: 0, replyCredit: 0, outbox: Promise.resolve(), outboxBytes: 0,
      }
      chan.conns.set(conn.cid, conn)
      conns.add(conn)
      try {
        const timeoutMs = limits.connectTimeoutMs
        const guard = deferred()
        const timer = unref(setTimeout(() => { conn.ac.abort(new Error('connect timeout')); guard.reject(Object.assign(new Error('connect timed out'), { code: 'TIMEOUT' })) }, timeoutMs))
        let dialed
        try { dialed = await Promise.race([dialUdp({ host: conn.host, port: conn.port, wide: grant.via === 'wide', signal: conn.ac.signal, timeoutMs }), guard.promise]) } finally { clearTimeout(timer) }
        if (!dialed || typeof dialed !== 'object' || !dialed.socket || typeof dialed.socket.on !== 'function' || typeof dialed.socket.send !== 'function') throw Object.assign(new Error('dialUdp returned no socket'), { code: 'FAILED' })
        conn.socket = dialed.socket
        conn.socket.on('error', () => endConnection(conn, 'origin-error'))
        conn.socket.on('close', () => endConnection(conn, 'origin-error'))
        conn.address = text(dialed.address, 64)
        conn.addressClass = text(dialed.class, 32)
        if (conn.ended) return refuse(req, 'udp', endedAnswer(conn), { detail: conn.endReason })
        // Wide mode is public addresses only, whatever a dial was configured to allow for named destinations.
        if (grant.via === 'wide' && dialed.class !== 'public') {
          endConnection(conn, 'closed')
          return refuse(req, 'udp', refusalAnswer('destination-refused', { addressClass: conn.addressClass }), { address: conn.address })
        }
        conn.down = await chan.streams.open({ cid: conn.cid, kind: KIND_DOWN }, { signal: conn.ac.signal, timeoutMs: limits.upWaitMs })
        if (conn.ended) return refuse(req, 'udp', endedAnswer(conn), { detail: conn.endReason })
      } catch (e) {
        const answer = conn.ended && ['revoked', 'shutdown'].includes(conn.endReason) ? endedAnswer(conn) : refusalOf(e, 'dial')
        endConnection(conn, 'closed')
        return refuse(req, 'udp', answer, { address: conn.address })
      }
      conn.opened = true
      conn.state = 'awaiting-up'
      counters.opened += 1
      udpCounters.flows += 1
      peerStats(peer).connections += 1
      peerStats(peer).open += 1
      conn.upTimer = unref(setTimeout(() => endConnection(conn, 'up-timeout'), limits.upWaitMs))
      conn.durationTimer = unref(setTimeout(() => endConnection(conn, 'time-budget'), limits.maxDurationMs))
      conn.meterTimer = unref(setInterval(() => emitMeter(conn, false), limits.meterIntervalMs))
      touch(conn)
      conn.socket.on('message', (message) => onReply(conn, message))
      conn.down.signal?.addEventListener('abort', () => { if (!conn.ended) endConnection(conn, 'consumer-left') }, { once: true })
      audit('egress-open', { outcome: 'opened', peer, form: 'udp', host: conn.host, port: conn.port, address: conn.address, addressClass: conn.addressClass, via: conn.via })
      try {
        indicator?.connected({ peer, host: conn.host, port: conn.port, form: 'udp' }, { stop: async () => { endConnection(conn, 'shutdown'); return true } })
      } catch { /* the embedder's callback */ }
      return { ok: true, maxDatagramBytes: limits.maxDatagramBytes }
    })

    // ---- resolve
    channel.onRequest(RESOLVE_METHOD, async (params) => {
      counters.requests += 1
      const { req, answer: early } = await admit(params, 'dns', validateResolve)
      if (early) return refuse(req, 'dns', early)
      if (!dnsRate.take(peer).ok) return refuse(req, 'dns', refusalAnswer('budget-exceeded', { budget: 'dns-rate' }))
      const grant = authoriseResolve(peer, req.name)
      if (!grant.ok) return refuse(req, 'dns', refusalAnswer(grant.code))
      if (!(await verified(req, 'resolve'))) return refuse(req, 'dns', refusalAnswer('bad-request'), { detail: 'request-unverified' })
      if (deny) {
        let vetoed
        try { vetoed = (await deny({ peer, host: req.name, port: 0 })) === true } catch { vetoed = true }
        if (vetoed) return refuse(req, 'dns', refusalAnswer('destination-refused'))
      }
      const startedAt = now()
      counters.lookups += 1
      peerStats(peer).lookups += 1
      const ac = new AbortController()
      const guard = deferred()
      const timer = unref(setTimeout(() => { ac.abort(new Error('lookup timeout')); guard.reject(Object.assign(new Error('lookup timed out'), { code: 'LOOKUP_FAILED' })) }, limits.connectTimeoutMs))
      let answers
      try {
        answers = await Promise.race([resolve({ name: req.name, wide: grant.via === 'wide', signal: ac.signal, timeoutMs: limits.connectTimeoutMs }), guard.promise])
        if (!Array.isArray(answers)) throw Object.assign(new Error('resolve returned no list'), { code: 'LOOKUP_FAILED' })
      } catch (e) {
        const answer = refusalOf(e, 'resolve')
        meter({ peer, form: 'dns', connections: 1, bytesUp: 0, bytesDown: 0, durationMs: Math.max(0, now() - startedAt), reason: answer.code, final: true })
        return refuse(req, 'dns', answer)
      } finally { clearTimeout(timer) }
      const addresses = []
      for (const a of answers) {
        const address = typeof a === 'string' ? a : a?.address
        // Wide mode: only public answers; anything the provider's resolver let through that is not public is dropped, not told.
        if (typeof address !== 'string' || (grant.via === 'wide' && typeof a === 'object' && a.class !== undefined && a.class !== 'public')) continue
        if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(address) && !addresses.includes(address)) addresses.push(address)
        if (addresses.length >= MAX_ANSWER_ADDRESSES) break
      }
      if (addresses.length === 0) {
        meter({ peer, form: 'dns', connections: 1, bytesUp: 0, bytesDown: 0, durationMs: Math.max(0, now() - startedAt), reason: 'name-not-found', final: true })
        return refuse(req, 'dns', refusalAnswer('name-not-found'))
      }
      audit('egress-resolve', { outcome: 'answered', peer, form: 'dns', host: req.name, addresses: addresses.length, durationMs: Math.max(0, now() - startedAt) })
      meter({ peer, form: 'dns', connections: 1, bytesUp: 0, bytesDown: 0, durationMs: Math.max(0, now() - startedAt), reason: 'closed', final: true })
      return { ok: true, addresses }
    })

    channel.onClose(() => {
      channels.delete(chan)
      for (const conn of [...chan.conns.values()]) endConnection(conn, 'consumer-left', { notify: false })
      chan.streams.close()
    })
  }

  // ----------------------------------------------------------- recheck, start, stop
  /** Ask the registry again about every live connection (of `peer`, or all): one whose grant is gone is ended `revoked`. */
  function recheck(peer) {
    for (const conn of [...conns]) {
      if (peer !== undefined && conn.peer !== peer) continue
      let ok = false
      try { ok = conn.still?.() ?? true } catch { ok = false }
      if (!ok) endConnection(conn, 'revoked')
    }
  }

  return {
    /** Begin serving. Refuses unless an indicator was given or `unattended: true`: someone sees what this pod lends, or nobody is there to. */
    start() {
      if (stopped) throw new Error('createMeshEgress: this provider was stopped')
      if (started) return
      if (!indicator && unattended !== true) throw new TypeError('createMeshEgress: start() needs an indicator (the person at this pod sees what it lends and can stop it) or unattended: true')
      started = true
      if (typeof registry.onAccessChange === 'function') offAccess = registry.onAccessChange((change) => recheck(change?.pubKey))
      interval = unref(setInterval(() => recheck(), recheckIntervalMs))
      stopServing = api.serveProtocol(protocol, accept, { versions: [...EGRESS_VERSIONS] })
    },
    /** End every connection and stop serving. There is no resume. */
    async stop() {
      if (stopped) return
      stopped = true
      try { stopServing?.() } catch { /* already stopped */ }
      try { offAccess?.() } catch { /* already off */ }
      clearInterval(interval)
      for (const conn of [...conns]) endConnection(conn, 'shutdown')
      for (const chan of [...channels]) { try { chan.channel.close('stopped') } catch { /* gone */ } }
      channels.clear()
    },
    recheck,
    get started() { return started && !stopped },
    /** The open connections now: who, where, since when, how many bytes. */
    get connections() { return [...conns].filter((c) => c.opened).map((c) => ({ peer: c.peer, host: c.host, port: c.port, address: c.address, since: c.startedAt, bytesUp: c.bytesUp, bytesDown: c.bytesDown })) },
    stats() {
      return {
        ...counters, reasons: { ...counters.reasons }, ends: { ...counters.ends }, udp: { ...udpCounters, dropped: { ...udpCounters.dropped } },
        open: [...conns].filter((c) => c.opened).length, channels: channels.size,
        peers: Object.fromEntries([...perPeer].map(([k, v]) => [k, { ...v }])),
      }
    },
  }
}

export { EGRESS_SCOPES, REFUSAL_CODES, BUDGET_NAMES }
