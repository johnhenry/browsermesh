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
