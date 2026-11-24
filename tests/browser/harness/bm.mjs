/**
 * In-page harness. Loaded by index.html under the strict policy; exposes
 * `window.bm`, a set of small functions the Playwright tests drive.
 *
 * Packages are imported with their bare names (resolved by the import map)
 * and lazily, so a test only loads what it uses. Everything here is
 * observable from the outside through plain, synchronous state on `bm`
 * (arrays and maps), which is what the tests wait on with
 * `page.waitForFunction(<sync predicate>)`.
 */

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const wsBase = () => location.origin.replace(/^http/, 'ws')

/** Violations of the page's own Content-Security-Policy, for the tests to assert on. */
const violations = []
document.addEventListener('securitypolicyviolation', (e) => {
  violations.push(`${e.violatedDirective} blocked ${e.blockedURI}`)
})

/** A `PeerNode`-shaped adapter over the open data channel (what attachService needs). */
function meshNode(st) {
  return {
    podId: st.local,
    onIncomingData(cb) {
      const listener = (data) => cb(st.remote, data)
      st.listeners.add(listener)
      return () => st.listeners.delete(listener)
    },
    async sendTo(_pubKey, data) { st.conn.send(data) },
  }
}

const bm = {
  violations,

  /**
   * Measured when the module loads (only for `/?probe`, because each blocked
   * call is itself a reported violation), from the page's own task: code that
   * Playwright evaluates over CDP is exempt from the policy, so asking at
   * test time would always answer "allowed".
   */
  policyFacts: !location.search.includes('probe') ? null : (() => {
    let evalBlocked = false
    try { (0, eval)('1 + 1') } catch { evalBlocked = true }
    let functionBlocked = false
    try { new Function('return 1')() } catch { functionBlocked = true }
    return { evalBlocked, functionBlocked, isolated: crossOriginIsolated }
  })(),

  // -- identity -------------------------------------------------------------

  identity: null,
  /** Generate an Ed25519 identity with the package, in this page. */
  async identityCreate() {
    const { PodIdentity } = await import('@johnhenry/browsermesh-primitives')
    bm.identity = await PodIdentity.generate()
    const raw = await crypto.subtle.exportKey('raw', bm.identity.keyPair.publicKey)
    return { podId: bm.identity.podId, publicKey: b64(raw) }
  },
  async identitySign(text) {
    return b64(await bm.identity.sign(new TextEncoder().encode(text)))
  },
  /** Verify a signature made in ANOTHER page, given only its public key bytes. */
  async identityVerify(publicKeyB64, signatureB64, text) {
    const { PodIdentity } = await import('@johnhenry/browsermesh-primitives')
    const publicKey = await crypto.subtle.importKey('raw', unb64(publicKeyB64), 'Ed25519', true, ['verify'])
    return PodIdentity.verify(publicKey, unb64(signatureB64), new TextEncoder().encode(text))
  },

  // -- sealed routed messages: key statements and the box, real WebCrypto ------

  sealing: null,
  /** Make an identity, an X25519 agreement key and a signed key statement for them; returns the statement. */
  async sealingPublish() {
    const { PodIdentity, generateAgreementKeyPair, createKeyStatement, supportsKeyAgreement } = await import('@johnhenry/browsermesh-primitives')
    const identity = await PodIdentity.generate()
    const agreement = await generateAgreementKeyPair()
    const statement = await createKeyStatement(identity, agreement, { lifetimeMs: 3_600_000 })
    bm.sealing = { identity, agreement, statement }
    return { supported: await supportsKeyAgreement(), statement }
  },
  /** Verify a statement made in ANOTHER page and seal `text` to it; `header` stands for the routing header. Returns the box, or the refusal code. */
  async sealingSeal(statement, header, text) {
    const { verifyKeyStatement, sealToStatement } = await import('@johnhenry/browsermesh-primitives')
    const enc = new TextEncoder()
    try {
      const verified = await verifyKeyStatement(statement, {})
      return { box: await sealToStatement(verified, { aad: enc.encode(header), plaintext: enc.encode(text) }) }
    } catch (err) {
      return { refused: err.code ?? String(err) }
    }
  },
  /** Open a box sealed in ANOTHER page with this page's key; the refusal code when it does not open. */
  async sealingOpen(box, header) {
    const { openSealed } = await import('@johnhenry/browsermesh-primitives')
    const keys = new Map([[bm.sealing.statement.kid, bm.sealing.agreement]])
    try {
      return { text: new TextDecoder().decode(await openSealed(box, { privateKeys: keys, aad: new TextEncoder().encode(header) })) }
    } catch (err) {
      return { refused: err.code ?? String(err) }
    }
  },
  /** A statement signed by a different identity but naming this page's pod id: it must be refused. */
  async sealingForge(statement) {
    const { PodIdentity, generateAgreementKeyPair, createKeyStatement } = await import('@johnhenry/browsermesh-primitives')
    const other = await PodIdentity.generate()
    const forged = await createKeyStatement(other, await generateAgreementKeyPair(), { lifetimeMs: 3_600_000 })
    return { ...forged, podId: statement.podId }
  },

  // -- pods over BroadcastChannel or the WebSocket relay --------------------

  pod: null,
  /** Messages the pod received, as `{from, to, payload}`. */
  inbox: [],
  async podBoot({ channel, relay = false } = {}) {
    const { Pod, WebSocketTransport } = await import('@johnhenry/browsermesh-pod')
    const { PodIdentity } = await import('@johnhenry/browsermesh-primitives')
    const identity = await PodIdentity.generate()
    const opts = { identity, discoveryTimeout: 300 }
    if (relay) {
      opts.transport = new WebSocketTransport({
        url: `${wsBase()}/relay`,
        podId: identity.podId,
        protocol: 'relay',
        peersFromSignaling: true,
        signalingUrl: `${wsBase()}/signaling`,
      })
    } else {
      opts.discoveryChannel = channel
    }
    const pod = new Pod()
    pod.on('message', (m) => bm.inbox.push({ from: m.from, to: m.to, payload: m.payload }))
    await pod.boot(opts)
    bm.pod = pod
    return pod.podId
  },
  podSend(to, payload) { bm.pod.send(to, payload) },
  async podShutdown() { await bm.pod?.shutdown(); bm.pod = null },

  // -- the window message channel ---------------------------------------------

  frames: [],
  /** What the window-channel pod delivered: `{from, payload, authenticated}`. */
  windowInbox: [],
  /** Add an iframe (the page's policy must allow the origin as `frame-src`); resolves on load. */
  addFrame(url) {
    return new Promise((resolve) => {
      const frame = document.createElement('iframe')
      frame.addEventListener('load', () => resolve(bm.frames.length - 1))
      frame.src = url
      bm.frames.push(frame)
      document.body.append(frame)
    })
  },
  /**
   * Boot a pod with no transport, listening to windows as configured:
   * `trustFrame: n` (the nth frame this page added), `parent: true`, `origins: [...]`.
   * With none of them it accepts nothing from another window (the default).
   */
  async windowPodBoot({ trustFrame, parent, origins } = {}) {
    const { Pod, NullTransport } = await import('@johnhenry/browsermesh-pod')
    const win = {}
    if (trustFrame !== undefined) win.sources = [bm.frames[trustFrame].contentWindow]
    if (parent) win.parent = true
    if (origins) win.origins = origins
    const pod = new Pod()
    pod.on('message', (m) => bm.windowInbox.push({ from: m.from, payload: m.payload, authenticated: m.authenticated }))
    await pod.boot({
      transport: new NullTransport(),
      window: Object.keys(win).length ? win : undefined,
      discoveryTimeout: 10,
      handshakeTimeout: 10,
    })
    bm.pod = pod
    return pod.podId
  },
  /** Post a pod message to another window: `'parent'`, `'frame:n'` (a frame this page added), `'sibling:n'` (a frame of the parent). */
  async windowPost(target, { to, payload, signed = false }) {
    const { createMessage, MessageSigner } = await import('@johnhenry/browsermesh-pod')
    const [kind, n] = target.split(':')
    const w = kind === 'parent' ? window.parent : kind === 'frame' ? bm.frames[Number(n)].contentWindow : window.parent.frames[Number(n)]
    let msg = createMessage({ from: bm.pod.podId, to, payload })
    if (signed) msg = await new MessageSigner(bm.pod.identity).sign(msg)
    else msg = { ...msg, from: 'an-unsigned-sender' }
    w.postMessage(msg, '*')
  },

  /** Plain BroadcastChannel, no package code: used to prove origins are isolated. */
  rawChannel: null,
  rawInbox: [],
  rawOpen(name) {
    bm.rawChannel = new BroadcastChannel(name)
    bm.rawChannel.onmessage = (e) => bm.rawInbox.push(e.data)
  },
  rawPost(data) { bm.rawChannel.postMessage(data) },

  // -- a real WebRTC data channel, signalled through /signaling -------------

  rtc: null, // { local, remote, ws, conn, inbox: [], events: [] }
  /**
   * Register with the local signalling server. `signal` messages are:
   *   {kind:'offer'|'answer', description, renegotiation?} and {kind:'ice', candidate}
   * An offer from the peer is answered automatically, on a fresh connection
   * unless it is a renegotiation of the current one.
   */
  /** Generate this page's pod identity (for identity binding); returns its pod id, which is then the signalling id. */
  rtcIdentity: null,
  async rtcIdentityCreate() {
    const { PodIdentity } = await import('@johnhenry/browsermesh-primitives')
    bm.rtcIdentity = await PodIdentity.generate()
    return bm.rtcIdentity.podId
  },
  /** `identity: true` proves this page's pod key on every connection (see `rtcIdentityCreate`). */
  async rtcRegister({ local, remote, identity = false, bindingTimeoutMs }) {
    const { WebRTCPeerConnection } = await import('@johnhenry/browsermesh-transport')
    const st = { local, remote, ws: null, conn: null, inbox: [], events: [], listeners: new Set(), answered: 0 }
    bm.rtc = st

    const signal = (payload) => st.ws.send(JSON.stringify({ type: 'signal', target: remote, envelope: payload }))
    const fresh = () => {
      // No STUN, no TURN: host candidates only, so the link is loopback.
      const conn = new WebRTCPeerConnection({
        localPodId: local,
        remotePodId: remote,
        iceServers: [],
        ...(identity ? { identity: bm.rtcIdentity, ...(bindingTimeoutMs ? { bindingTimeoutMs } : {}) } : {}),
      })
      conn.onIceCandidate((candidate) => signal({ kind: 'ice', candidate }))
      conn.onMessage((data) => { st.inbox.push(data); for (const cb of st.listeners) cb(data) })
      conn.onStateChange((state) => st.events.push(state))
      st.conn = conn
      return conn
    }
    st.fresh = fresh
    st.signal = signal

    st.ws = new WebSocket(`${wsBase()}/signaling`)
    st.ws.addEventListener('message', async (event) => {
      const msg = JSON.parse(event.data)
      if (msg.type !== 'signal') return
      const { kind, description, candidate, renegotiation } = msg.envelope
      if (kind === 'offer') {
        const conn = renegotiation && st.conn ? st.conn : fresh()
        signal({ kind: 'answer', description: await conn.handleOffer(description) })
      } else if (kind === 'answer') {
        await st.conn.handleAnswer(description)
        st.answered += 1
      } else if (kind === 'ice') {
        await st.conn?.addIceCandidate(candidate)
      }
    })
    await new Promise((resolve, reject) => {
      st.ws.addEventListener('open', () => st.ws.send(JSON.stringify({ type: 'register', podId: local })))
      st.ws.addEventListener('error', () => reject(new Error('signalling socket failed')))
      st.ws.addEventListener('message', (event) => {
        if (JSON.parse(event.data).type === 'registered') resolve()
      })
    })
    return local
  },
  /** Start the offer (caller side). The answer and ICE come back through the socket. */
  async rtcOffer() {
    const st = bm.rtc
    const conn = st.fresh()
    st.signal({ kind: 'offer', description: await conn.createOffer() })
  },
  /** ICE restart on the live connection (the package's own `reconnect`). */
  async rtcRenegotiate() {
    const st = bm.rtc
    const offer = await st.conn.reconnect({ force: true })
    st.signal({ kind: 'offer', description: offer, renegotiation: true })
  },
  rtcOpen() { return !!bm.rtc?.conn?.isOpen },
  rtcStatus() { const c = bm.rtc.conn; return { state: c.state, bound: c.bound, failure: c.bindingFailure } },

  /**
   * An attacker that holds the signalling server: the test double hands it every offer, answer and ICE
   * frame (`hub.intercept`), and it answers the offerer as the callee and offers to the callee as the
   * offerer, with two RTCPeerConnections of its own, relaying everything that crosses the data channel.
   * It has no identity, so it cannot make a proof of its own; it can only pass the victims' proofs along.
   */
  mitm: null,
  async mitmStart(attackerId) {
    const { WebRTCPeerConnection } = await import('@johnhenry/browsermesh-transport')
    const st = { legs: new Map(), seen: [] }
    bm.mitm = st
    const ws = new WebSocket(`${wsBase()}/signaling`)
    const send = (target, envelope) => ws.send(JSON.stringify({ type: 'signal', target, envelope }))
    ws.addEventListener('message', async (event) => {
      const msg = JSON.parse(event.data)
      if (msg.type !== 'signal' || !msg.envelope?.mitm) return
      const { mitm: { from, to }, kind, description, candidate } = msg.envelope
      if (kind === 'offer') {
        const facing = new WebRTCPeerConnection({ localPodId: to, remotePodId: from, iceServers: [] })
        const behind = new WebRTCPeerConnection({ localPodId: from, remotePodId: to, iceServers: [] })
        st.legs.set(`${from}>${to}`, { facing, behind })
        facing.onIceCandidate((c) => send(from, { kind: 'ice', candidate: c }))
        behind.onIceCandidate((c) => send(to, { kind: 'ice', candidate: c }))
        facing.onMessage((data) => { st.seen.push(data); try { behind.send(data) } catch { /* not open yet */ } })
        behind.onMessage((data) => { st.seen.push(data); try { facing.send(data) } catch { /* not open yet */ } })
        facing.onClose(() => behind.close())
        behind.onClose(() => facing.close())
        send(from, { kind: 'answer', description: await facing.handleOffer(description) })
        send(to, { kind: 'offer', description: await behind.createOffer() })
      } else if (kind === 'answer') {
        await st.legs.get(`${to}>${from}`)?.behind.handleAnswer(description)
      } else if (kind === 'ice') {
        const offererSide = st.legs.get(`${from}>${to}`)
        const answererSide = st.legs.get(`${to}>${from}`)
        if (offererSide) await offererSide.facing.addIceCandidate(candidate)
        else if (answererSide) await answererSide.behind.addIceCandidate(candidate)
      }
    })
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'register', podId: attackerId })))
      ws.addEventListener('error', () => reject(new Error('attacker socket failed')))
      ws.addEventListener('message', (event) => { if (JSON.parse(event.data).type === 'registered') resolve() })
    })
  },
  rtcSend(data) { bm.rtc.conn.send(data) },
  rtcClose() { bm.rtc.conn.close() },
  rtcUnregister() { bm.rtc?.conn?.close(); bm.rtc?.ws.close(); bm.rtc = null },
  async digest(text) {
    return b64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  },

  // -- the transport package's WebSocketTransport, against /echo ------------

  wsTransport: null,
  wsInbox: [],
  async wsConnect() {
    const { WebSocketTransport } = await import('@johnhenry/browsermesh-transport')
    const t = new WebSocketTransport({ url: `${wsBase()}/echo`, reconnect: false, heartbeatIntervalMs: 600000 })
    t.on('message', (data) => bm.wsInbox.push(data))
    await t.connect()
    bm.wsTransport = t
  },
  wsSend(data) { bm.wsTransport.send(data) },
  wsClose() { bm.wsTransport.close() },

  // -- mesh-rpc over the live WebRTC data channel ---------------------------

  rpc: null,
  async rpcServe() {
    const { attachService, createMeshRpcService } = await import('@johnhenry/browsermesh-apps')
    bm.rpcRequests = []
    bm.rpc = attachService(meshNode(bm.rtc), undefined, createMeshRpcService({
      onRequest: async ({ method, path, body }) => {
        bm.rpcRequests.push({ method, path })
        if (method === 'GET' && path === '/whoami') return { status: 200, body: { podId: bm.rtc.local } }
        if (method === 'POST' && path === '/echo') return { status: 200, body: { youSaid: body } }
        return { status: 404, body: { error: `no route for ${method} ${path}` } }
      },
    }))
  },
  async rpcClient() {
    const { attachService, createMeshRpcService, createBrowserMeshFetch } = await import('@johnhenry/browsermesh-apps')
    bm.rpc = attachService(meshNode(bm.rtc), undefined, createMeshRpcService({}))
    bm.meshFetch = createBrowserMeshFetch(bm.rpc.api)
  },
  async rpcFetch(path, init) {
    const res = await bm.meshFetch(`mesh://${bm.rtc.remote}${path}`, init)
    return { status: res.status, contentType: res.headers.get('content-type'), body: await res.json() }
  },

  // -- a protocol channel (message channel + protocol seam) over the live WebRTC data channel --

  proto: null,
  /**
   * Host side: serve the `counter` protocol, authorised by this page's own PeerRegistry (default deny).
   * `limits` are the message channel's (`window`, `maxMessageBytes`, `chunkBytes`).
   */
  async protoServe(limits = {}) {
    const apps = await import('@johnhenry/browsermesh-apps')
    const node = meshNode(bm.rtc)
    // The registry's own in-package defaults (no core import: its vault dependency is not in the page's import map).
    node.registry = new apps.PeerRegistry({ localPodId: node.podId })
    const st = { node, registry: node.registry, value: 0, subs: new Set(), received: 0, gate: Promise.resolve(), openGate: null, aborted: 0, who: [], closed: 0 }
    bm.proto = st
    st.svc = apps.attachService(node, undefined, apps.createMeshProtocolService(limits))
    st.svc.api.serveProtocol('counter', (ch) => {
      ch.onRequest('get', () => st.value)
      ch.onRequest('inc', ({ n = 1 }) => {
        st.value += n
        for (const cb of [...st.subs]) cb(st.value)
        return st.value
      })
      ch.onRequest('whoami', (_params, ctx) => { st.who.push(ctx.peer); return { peer: ctx.peer, channelPeer: ch.peer } })
      ch.onRequest('bytes', ({ size }) => Uint8Array.from({ length: size }, (_, i) => (i * 31) % 251))
      ch.onRequest('steps', async ({ n }, { progress }) => {
        for (let i = 1; i <= n; i++) await progress({ step: i, bytes: new Uint8Array(3).fill(i) })
        return 'done'
      })
      ch.onRequest('slow', (_params, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { st.aborted += 1; reject(signal.reason) })
      }))
      ch.onRequest('subscribe', () => {
        const cb = (value) => ch.notify('changed', { value }).catch(() => {})
        st.subs.add(cb)
        ch.onClose(() => st.subs.delete(cb))
        return true
      })
      ch.onMessage(async () => { st.received += 1; await st.gate })
      ch.onClose(() => { st.closed += 1 })
    })
  },
  protoGrant(peer, scopes) { bm.proto.registry.grantCapabilities(peer, scopes) },
  protoRevoke(peer, scopes) { bm.proto.registry.revokeCapabilities(peer, scopes) },
  /** Hold the host's raw-message reader (a reader that is not reading). */
  protoGateClose() { bm.proto.gate = new Promise((resolve) => { bm.proto.openGate = resolve }) },
  protoGateOpen() { bm.proto.openGate() },
  protoHostState() {
    const link = bm.proto.svc.api.channel.link(bm.rtc.remote)
    return { received: bm.proto.received, heldBytes: link ? link.stats().heldBytes : -1, aborted: bm.proto.aborted, closed: bm.proto.closed, who: bm.proto.who, value: bm.proto.value }
  },
  /** Client side: attach the protocol service. */
  async protoClient(limits = {}) {
    const apps = await import('@johnhenry/browsermesh-apps')
    const st = { changes: [], progress: [], sends: [], sendResults: null, closed: 0, ch: null }
    bm.proto = st
    st.svc = apps.attachService(meshNode(bm.rtc), undefined, apps.createMeshProtocolService(limits))
  },
  /** Open a protocol: `{ name, version }` or `{ error: { code, reason } }`. */
  async protoOpen(name) {
    const st = bm.proto
    try {
      st.ch = await st.svc.api.openProtocol(bm.rtc.remote, name, { timeoutMs: 15000 })
      st.ch.onClose(() => { st.closed += 1 })
      st.ch.onNotification('changed', ({ value }) => st.changes.push(value))
      return { name: st.ch.name, version: st.ch.version, peer: st.ch.peer }
    } catch (e) { return { error: { code: e.code, reason: e.reason } } }
  },
  /** One request; bytes come back as `{ bytes, digest }` (the page hashes them, the test compares). */
  async protoRequest(method, params) {
    try {
      const res = await bm.proto.ch.request(method, params, { timeoutMs: 15000 })
      if (res instanceof Uint8Array) return { value: { bytes: res.length, digest: b64(await crypto.subtle.digest('SHA-256', res)) } }
      return { value: res }
    } catch (e) { return { error: { code: e.code, reason: e.reason } } }
  },
  protoSteps(n) {
    const st = bm.proto
    st.progress = []
    return st.ch.request('steps', { n }, { onProgress: (p) => st.progress.push({ step: p.step, bytes: [...p.bytes] }) })
  },
  protoSlowStart() {
    const st = bm.proto
    st.slowAbort = new AbortController()
    st.slowResult = null
    st.ch.request('slow', {}, { signal: st.slowAbort.signal }).then(
      () => { st.slowResult = { ok: true } },
      (e) => { st.slowResult = { code: e.code, reason: e.reason } },
    )
  },
  protoSlowAbort() { bm.proto.slowAbort.abort() },
  protoNotify(method, params) { return bm.proto.ch.notify(method, params) },
  /** Send `count` raw messages of `size` bytes at once, without waiting. */
  protoFlood(count, size) {
    const st = bm.proto
    st.sendsDone = 0
    st.sends = Array.from({ length: count }, (_, i) => st.ch.send({ i, pad: new Uint8Array(size) }).then(() => { st.sendsDone += 1 }, () => {}))
  },
  protoClientState() {
    const st = bm.proto
    const link = st.svc.api.channel.link(bm.rtc.remote)
    return { queuedBytes: link ? link.stats().queuedBytes : -1, creditBytes: link ? link.stats().creditBytes : -1, sendsDone: st.sendsDone ?? 0, changes: st.changes, closed: st.closed, slowResult: st.slowResult ?? null, progress: st.progress }
  },
  async protoExpectedDigest(size) {
    const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 31) % 251)
    return b64(await crypto.subtle.digest('SHA-256', bytes))
  },

  // -- CRDT sync over the live WebRTC data channel --------------------------

  crdt: null,
  async crdtStart(nodeId) {
    const { MeshSyncEngine } = await import('@johnhenry/browsermesh-sync')
    const engine = new MeshSyncEngine({ nodeId })
    engine.create('likes', 'g-counter')
    engine.create('settings', 'lww-map')
    bm.crdt = engine
    bm.rtc.listeners.add((data) => {
      if (data && data.crdt) engine.merge(data.name, data.payload)
    })
  },
  crdtEdit(kind) {
    const id = bm.rtc.local
    if (kind === 'counter') bm.crdt.update('likes', (c) => c.increment(id, id === 'pod-alice' ? 5 : 3))
    else bm.crdt.update('settings', (m) => (id === 'pod-alice'
      ? m.set('theme', 'dark', 100, id)
      : m.set('locale', 'en-US', 200, id)))
  },
  crdtPush() {
    for (const name of ['likes', 'settings']) {
      bm.rtc.conn.send({ crdt: true, name, payload: bm.crdt.prepareSyncPayload(name) })
    }
  },
  crdtState() {
    return { likes: bm.crdt.getState('likes'), settings: bm.crdt.getState('settings') }
  },

  // -- examples, unmodified, in the page ------------------------------------

  async runExample(file) {
    await import(`/examples/${file}`)
  },
}

window.bm = bm
window.bmReady = true
