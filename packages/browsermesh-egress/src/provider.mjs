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
import { createByteBudget, createInflight, createRateLimiter, resolveLimits } from './limits.mjs'
import {
  CONNECT_METHOD, EGRESS_CONSUMER, EGRESS_PROTOCOL, EGRESS_VERSIONS, END_METHOD, KIND_DOWN, KIND_UP, MAX_ANSWER_ADDRESSES, RESOLVE_METHOD,
  signedRequestBytes, validateConnect, validateResolve, validateStreamMeta,
} from './wire.mjs'

/** Ports refused by default: mail submission (SMTP relay, SMTPS, submission). */
export const DEFAULT_BLOCKED_PORTS = Object.freeze([25, 465, 587])
/** What an operator writes to acknowledge wide mode: any PUBLIC destination for a holder of a wildcard grant. */
export const WIDE_ACKNOWLEDGEMENT = 'any-public-address'

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

/** The answer for a connection that was ended while it was still being made: the grant went, or the provider stopped. */
const endedAnswer = (conn) => refusalAnswer(conn.endReason === 'shutdown' ? 'shutting-down' : 'no-grant')

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
  service, registry, dial, resolve, sets, wide, blockedPorts = DEFAULT_BLOCKED_PORTS, limits: limitOptions, allowFrom, deny, verifyRequest,
  indicator, unattended, onAudit, onMeter, clock, recheckIntervalMs = 30_000, protocol = EGRESS_PROTOCOL, onLog,
} = {}) {
  const api = service && typeof service === 'object' ? (service.api ?? service) : null
  if (typeof api?.serveProtocol !== 'function') throw new TypeError('createMeshEgress: service is a mesh service with serveProtocol (createMeshProtocolService)')
  if (!registry || typeof registry.checkAccess !== 'function') throw new TypeError('createMeshEgress: registry is required: the grants are the registry\'s')
  for (const [name, fn] of Object.entries({ dial, resolve })) {
    if (typeof fn !== 'function') throw new TypeError(`createMeshEgress: ${name} is required (a function that reaches a network; \`nodeDialer()\` from the ./node entry builds both)`)
    // A provider dials from its own network. One built on another egress would pass its consumers on (a chain).
    if (fn[EGRESS_CONSUMER]) throw new TypeError(`createMeshEgress: ${name} is an egress consumer; a provider cannot be built on another egress (chaining is refused)`)
  }
  for (const [name, fn] of Object.entries({ deny, verifyRequest, onAudit, onMeter })) if (fn !== undefined && typeof fn !== 'function') throw new TypeError(`createMeshEgress: ${name} must be a function`)
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
  const byteBudget = createByteBudget(limits.maxBytesPerConsumer, { now, maxTracked: limits.maxTracked })
  const inflight = createInflight({ maxTracked: limits.maxTracked })

  const channels = new Set()
  const conns = new Set()
  const perPeer = new Map() // peer -> { connections, open, bytesUp, bytesDown, refused, lookups }
  const counters = { channels: 0, requests: 0, opened: 0, refused: 0, closed: 0, lookups: 0, bytesUp: 0, bytesDown: 0, reasons: {}, ends: {} }
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
  function authorise(peer, host, kind, port) {
    if (can(peer, `egress:tcp:*:*`, 'connect') || can(peer, `egress:tcp:*:${port}`, 'connect')) {
      return wideOn ? { ok: true, via: 'wide', still: () => can(peer, 'egress:tcp:*:*', 'connect') || can(peer, `egress:tcp:*:${port}`, 'connect') } : { ok: false, code: 'wide-not-acknowledged' }
    }
    if (can(peer, `egress:tcp:${host}:${port}`, 'connect')) return { ok: true, via: 'exact', still: () => can(peer, `egress:tcp:${host}:${port}`, 'connect') }
    if (can(peer, `egress:tcp:${host}:*`, 'connect')) return { ok: true, via: 'host', still: () => can(peer, `egress:tcp:${host}:*`, 'connect') }
    for (const name of setsCovering(compiled, host, kind, port)) {
      if (can(peer, `egress:set:${name}`, 'connect')) return { ok: true, via: 'set', set: name, still: () => can(peer, `egress:set:${name}`, 'connect') }
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
    try { conn.socket?.destroy() } catch { /* already closed */ }
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
      audit('egress-close', { outcome: 'closed', peer: conn.peer, form: 'tcp', host: conn.host, port: conn.port, address: conn.address, addressClass: conn.addressClass, bytesUp: conn.bytesUp, bytesDown: conn.bytesDown, durationMs: Math.max(0, now() - conn.startedAt), reason })
      emitMeter(conn, true, reason)
      try { indicator?.disconnected({ peer: conn.peer, host: conn.host, port: conn.port }) } catch { /* the embedder's callback */ }
    }
  }

  function emitMeter(conn, final, reason) {
    const bytesUp = conn.bytesUp - conn.meteredUp
    const bytesDown = conn.bytesDown - conn.meteredDown
    conn.meteredUp = conn.bytesUp
    conn.meteredDown = conn.bytesDown
    meter({ peer: conn.peer, form: 'tcp', connections: final ? 1 : 0, bytesUp, bytesDown, durationMs: Math.max(0, now() - conn.startedAt), reason: final ? reason : undefined, final })
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
    conn.idleTimer = unref(setTimeout(() => endConnection(conn, 'idle'), limits.idleMs))
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
    socket.on('error', () => endConnection(conn, 'origin-error'))
    socket.on('close', () => endConnection(conn, conn.originEnded ? 'closed' : 'origin-error'))
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
      pumpUp(conn)
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

    async function verified(req, form) {
      if (!verifyRequest) return true
      const bytes = signedRequestBytes({ form, cid: req.cid, nonce: req.nonce, host: req.host ?? req.name, port: req.port })
      try { return (await verifyRequest({ peer, bytes, sig: req.sig, request: { form, cid: req.cid, host: req.host ?? req.name, port: req.port } })) === true } catch { return false }
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
        cid: req.cid, peer, chan, host: req.host, port: req.port, via: grant.via, still: grant.still, ac: new AbortController(), releases, state: 'dialing',
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
      try { ok = conn.still() } catch { ok = false }
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
        ...counters, reasons: { ...counters.reasons }, ends: { ...counters.ends },
        open: [...conns].filter((c) => c.opened).length, channels: channels.size,
        peers: Object.fromEntries([...perPeer].map(([k, v]) => [k, { ...v }])),
      }
    },
  }
}

export { EGRESS_SCOPES, REFUSAL_CODES, BUDGET_NAMES }
