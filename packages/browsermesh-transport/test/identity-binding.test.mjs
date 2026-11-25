// Run with: node --import ./test/_setup-globals.mjs --test test/identity-binding.test.mjs
//
// Real RTCPeerConnection is NOT used here: `FakePC` is an in-memory duplex that
// negotiates with SDP strings and carries data channel messages between two
// WebRTCPeerConnection objects. The pure functions are tested over fixed
// vectors; the connection tests drive the same code path a real connection
// uses (createOffer/handleOffer/handleAnswer, the control data channel).
// A real-browser run of this path has not been made (see issue #270).
import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { PodIdentity } from '@johnhenry/browsermesh-primitives'

// ---------------------------------------------------------------------------
// In-memory RTCPeerConnection duplex
// ---------------------------------------------------------------------------

let fpSeq = 0
let offerSeq = 0
const offerers = new Map()

class FakeDC {
  readyState = 'connecting'
  onopen = null
  onmessage = null
  onclose = null
  onerror = null
  peer = null
  constructor(label) { this.label = label }
  send(data) {
    if (this.readyState !== 'open') throw new Error('not open')
    const p = this.peer
    queueMicrotask(() => { if (p.readyState === 'open') p.onmessage?.({ data }) })
  }
  close() {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    this.onclose?.()
    const p = this.peer
    if (p && p.readyState !== 'closed') queueMicrotask(() => p.close())
  }
}

function sdpFor(fingerprint) {
  return [
    'v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0',
    'a=group:BUNDLE 0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    `a=fingerprint:${fingerprint}`, 'a=setup:actpass', 'a=mid:0', '',
  ].join('\r\n')
}

class FakePC {
  channels = []
  ondatachannel = null
  onicecandidate = null
  onconnectionstatechange = null
  connectionState = 'new'
  constructor() {
    fpSeq++
    const hex = fpSeq.toString(16).padStart(2, '0').toUpperCase()
    this.fingerprint = `sha-256 ${Array(32).fill(hex).join(':')}`
  }
  createDataChannel(label) {
    const dc = new FakeDC(label)
    this.channels.push(dc)
    return dc
  }
  // The offer names its own offerer (a field that survives a signalling server rewriting `sdp`), so an answerer
  // pairs with the connection that made THE offer it was given, not with whichever one made an offer last
  // (a global would pair it with a stale connection left over from an earlier test).
  // (It travels as an SDP line, since the connection rebuilds the description it applies; a server that swaps
  // the fingerprint line leaves it alone.)
  async createOffer() {
    const id = ++offerSeq
    offerers.set(id, this)
    return { type: 'offer', sdp: `${sdpFor(this.fingerprint)}a=x-fake-offerer:${id}\r\n` }
  }
  async createAnswer() { return { type: 'answer', sdp: sdpFor(this.fingerprint) } }
  async setLocalDescription() {}
  async setRemoteDescription(desc) {
    FakePC.applied++
    if (desc.type === 'offer') {
      const offerer = offerers.get(Number(/a=x-fake-offerer:(\d+)/.exec(desc.sdp)?.[1]))
      this.offerer = offerer
      for (const oc of offerer.channels) {
        const mine = new FakeDC(oc.label)
        mine.peer = oc
        oc.peer = mine
        this.channels.push(mine)
        this.ondatachannel?.({ channel: mine })
      }
    } else {
      queueMicrotask(() => {
        for (const c of this.channels) {
          c.readyState = 'open'
          c.peer.readyState = 'open'
        }
        for (const c of this.channels) { c.onopen?.(); c.peer.onopen?.() }
      })
    }
  }
  addIceCandidate() {}
  async getStats() { return new Map() }
  close() { this.closed = true }
  get remoteDescription() { return null }
}
FakePC.applied = 0 // descriptions applied (setRemoteDescription calls), across all instances
globalThis.RTCPeerConnection = FakePC

const {
  WebRTCPeerConnection,
} = await import('../src/webrtc.mjs')
const {
  extractDtlsFingerprints, bindingTranscript, createBindingProof, verifyBindingProof, BINDING_DOMAIN,
  DESCRIPTION_DOMAIN, descriptionTranscript, signDescription, verifyDescription,
} = await import('../src/identity-binding.mjs')

const dec = new TextDecoder()

// ---------------------------------------------------------------------------
// Pure functions over fixed vectors
// ---------------------------------------------------------------------------

const JWK = { kty: 'OKP', crv: 'Ed25519', d: 'nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' }
const POD_A = 'If4x36FUomFia_hUBG_SJxt77UtqvkWqWId-9H-XIbk' // hash of JWK.x
const T = {
  offererPodId: POD_A,
  answererPodId: 'pod-answerer',
  offerFingerprints: ['sha-256 aa:bb'],
  answerFingerprints: ['sha-256 cc:dd'],
  signer: 'offerer',
}
const PROOF = {
  type: 'mesh:bind', v: 1, podId: POD_A, role: 'offerer', pk: JWK.x,
  sig: 'VzSRPF9KAibj9rmlE1MxF4hlqA_S7POaw69mfsRR11d8aa4sQzS_Ep1L5VpuOPLqsFj9i1s3p59Se39fFe1vBA',
}
const VERIFY = {
  expectedPodId: POD_A,
  peerRole: 'offerer',
  offererPodId: POD_A,
  answererPodId: 'pod-answerer',
  offerFingerprints: ['sha-256 aa:bb'],
  answerFingerprints: ['sha-256 cc:dd'],
}

describe('identity binding: pure functions', () => {
  it('extractDtlsFingerprints normalises, sorts and de-duplicates', () => {
    const sdp = [
      'v=0', 'a=fingerprint:SHA-256 AB:CD:EF', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
      'a=fingerprint:sha-256 ab:cd:ef', 'a=fingerprint:sha-1 01:02', '',
    ].join('\r\n')
    assert.deepEqual(extractDtlsFingerprints(sdp), ['sha-1 01:02', 'sha-256 ab:cd:ef'])
    assert.deepEqual(extractDtlsFingerprints('v=0\na=fingerprint:sha-256 zz\n'), [])
    assert.deepEqual(extractDtlsFingerprints('no fingerprint here'), [])
    assert.deepEqual(extractDtlsFingerprints(undefined), [])
  })

  it('fixed vector: transcript bytes', () => {
    assert.equal(BINDING_DOMAIN, 'browsermesh/webrtc-binding/v1\n')
    assert.equal(
      dec.decode(bindingTranscript(T)),
      `browsermesh/webrtc-binding/v1\n{"answerFp":["sha-256 cc:dd"],"answerer":"pod-answerer","offerFp":["sha-256 aa:bb"],"offerer":"${POD_A}","signer":"offerer"}`,
    )
  })

  it('fixed vector: the proof is reproduced and verifies', async () => {
    const id = await PodIdentity.fromJwk(JWK, { extractable: true })
    assert.equal(id.podId, POD_A)
    assert.deepEqual(await createBindingProof(id, T), PROOF)
    assert.deepEqual(await verifyBindingProof(PROOF, VERIFY), { ok: true })
  })

  it('each input of the transcript is bound: changing any one fails verification', async () => {
    const cases = {
      'offer fingerprint': { offerFingerprints: ['sha-256 aa:bc'] },
      'answer fingerprint': { answerFingerprints: ['sha-256 cc:de'] },
      'an extra fingerprint': { answerFingerprints: ['sha-256 cc:dd', 'sha-256 ee:ff'] },
      'answerer pod id': { answererPodId: 'pod-other' },
      'offerer pod id': { offererPodId: 'pod-other', expectedPodId: POD_A },
    }
    for (const [name, change] of Object.entries(cases)) {
      const verdict = await verifyBindingProof(PROOF, { ...VERIFY, ...change })
      assert.deepEqual(verdict, { ok: false, reason: 'bad-signature' }, name)
    }
  })

  it('a proof is refused when the key does not hash to the claimed pod id', async () => {
    assert.deepEqual(await verifyBindingProof(PROOF, { ...VERIFY, expectedPodId: 'pod-somebody-else' }), { ok: false, reason: 'wrong-pod-id' })
    assert.deepEqual(await verifyBindingProof({ ...PROOF, podId: 'pod-somebody-else' }, VERIFY), { ok: false, reason: 'wrong-pod-id' })
    // A valid proof by a different key, presented for POD_A.
    const other = await PodIdentity.generate()
    const forged = await createBindingProof(other, T)
    assert.deepEqual(await verifyBindingProof({ ...forged, podId: POD_A }, VERIFY), { ok: false, reason: 'wrong-pod-id' })
  })

  it('a proof cannot be reflected: the role is part of what was signed', async () => {
    assert.deepEqual(await verifyBindingProof(PROOF, { ...VERIFY, peerRole: 'answerer' }), { ok: false, reason: 'wrong-role' })
    assert.deepEqual(await verifyBindingProof({ ...PROOF, role: 'answerer' }, { ...VERIFY, peerRole: 'answerer' }), { ok: false, reason: 'bad-signature' })
  })

  it('a proof from another connection (other fingerprints) does not verify here', async () => {
    const id = await PodIdentity.fromJwk(JWK, { extractable: true })
    const earlier = await createBindingProof(id, { ...T, offerFingerprints: ['sha-256 11:11'] })
    assert.deepEqual(await verifyBindingProof(earlier, VERIFY), { ok: false, reason: 'bad-signature' })
  })

  it('malformed proofs and missing fingerprints are refused', async () => {
    for (const bad of [null, 5, {}, { ...PROOF, v: 2 }, { ...PROOF, type: 'x' }, { ...PROOF, sig: 'AAAA' }, { ...PROOF, pk: 'AAAA' }]) {
      assert.equal((await verifyBindingProof(bad, VERIFY)).ok, false)
    }
    assert.deepEqual(await verifyBindingProof(PROOF, { ...VERIFY, offerFingerprints: [] }), { ok: false, reason: 'no-fingerprint' })
    assert.throws(() => bindingTranscript({ ...T, answerFingerprints: [] }), TypeError)
    assert.throws(() => bindingTranscript({ ...T, signer: 'both' }), TypeError)
  })
})

// ---------------------------------------------------------------------------
// WebRTCPeerConnection over the in-memory duplex
// ---------------------------------------------------------------------------

async function pair({ aOpts = {}, bOpts = {}, tamperOffer = (o) => o, tamperAnswer = (a) => a, aId, bId } = {}) {
  const ida = aId ?? await PodIdentity.generate()
  const idb = bId ?? await PodIdentity.generate()
  const a = new WebRTCPeerConnection({ localPodId: ida.podId, remotePodId: idb.podId, iceServers: [], identity: ida, ...aOpts })
  const b = new WebRTCPeerConnection({ localPodId: idb.podId, remotePodId: ida.podId, iceServers: [], identity: idb, ...bOpts })
  const events = { a: [], b: [], errA: [], errB: [], msgA: [], msgB: [] }
  a.onError((e) => events.errA.push(e.message)); b.onError((e) => events.errB.push(e.message))
  a.onMessage((m) => events.msgA.push(m)); b.onMessage((m) => events.msgB.push(m))
  const when = (conn, state) => new Promise((resolve) => {
    if (conn.state === state) resolve()
    else conn.onStateChange((s) => { if (s === state) resolve() })
  })
  const offer = await a.createOffer()
  const answer = await b.handleOffer(tamperOffer(offer))
  await a.handleAnswer(tamperAnswer(answer))
  return { a, b, ida, idb, events, when }
}

// A signalling server that swaps a description and also drops the signature that came with it (the signature is
// checked before the description is applied, see "signed session descriptions"; these tests are about the proof
// on the connection that follows).
const dropSignature = (desc) => ({ type: desc.type, sdp: desc.sdp })
const swapFingerprint = (desc) => ({ ...desc, auth: undefined, sdp: desc.sdp.replace(/a=fingerprint:.*/, `a=fingerprint:sha-256 ${Array(32).fill('EE').join(':')}`) })

describe('identity binding: WebRTCPeerConnection', () => {
  it('connects only once both sides have proved their keys, then carries messages', async () => {
    const { a, b, events, when } = await pair()
    assert.equal(a.isOpen, false)
    assert.throws(() => a.send({ early: true }), /not verified/)
    await Promise.all([when(a, 'connected'), when(b, 'connected')])
    assert.equal(a.bound, true)
    assert.equal(b.bound, true)
    a.send({ hello: 'b' })
    b.send({ hello: 'a' })
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(events.msgB, [{ hello: 'b' }])
    assert.deepEqual(events.msgA, [{ hello: 'a' }])
    assert.deepEqual([events.errA, events.errB], [[], []])
    a.close(); b.close()
  })

  it('a signalling server that swaps the offer is detected by both sides, which close and report', async () => {
    const { a, b, events, when } = await pair({ tamperOffer: swapFingerprint, tamperAnswer: dropSignature })
    await Promise.all([when(a, 'closed'), when(b, 'closed')])
    // Whichever side verifies first reports and closes; the other then sees the channel close.
    assert.match([...events.errA, ...events.errB].join(), /identity binding failed: bad-signature/)
    assert.ok(a.bindingFailure === 'bad-signature' || b.bindingFailure === 'bad-signature')
    assert.equal(a.bound, false)
    assert.equal(b.bound, false)
    assert.deepEqual([events.msgA, events.msgB], [[], []])
  })

  it('a signalling server that swaps the answer is detected too', async () => {
    const { a, b, events, when } = await pair({ tamperOffer: dropSignature, tamperAnswer: swapFingerprint })
    await Promise.all([when(a, 'closed'), when(b, 'closed')])
    assert.equal(a.bound, false)
    assert.equal(b.bound, false)
    assert.match([...events.errA, ...events.errB].join(), /bad-signature/)
  })

  it('a peer whose key is not the pod id claimed for it is refused', async () => {
    const ida = await PodIdentity.generate()
    const idb = await PodIdentity.generate()
    const impostor = await PodIdentity.generate()
    // b believes it is talking to `impostor`'s pod id, but a holds ida's key.
    const a = new WebRTCPeerConnection({ localPodId: ida.podId, remotePodId: idb.podId, iceServers: [], identity: ida })
    const b = new WebRTCPeerConnection({ localPodId: idb.podId, remotePodId: impostor.podId, iceServers: [], identity: idb })
    const errB = []
    // Wait for the report of the failure itself, not for "closed" (which any other path could also reach first).
    const failedB = new Promise((resolve) => b.onError((e) => { errB.push(e.message); resolve() }))
    const closedB = new Promise((resolve) => b.onStateChange((s) => s === 'closed' && resolve()))
    const offer = await a.createOffer()
    // The description layer refuses a description signed by a key that is not the claimed pod before it is applied.
    await assert.rejects(() => b.handleOffer(offer), /wrong-pod-id/)
    // This test is about the proof on the connection: an older-style, unsigned offer reaches it.
    await a.handleAnswer(dropSignature(await b.handleOffer(dropSignature(offer))))
    await failedB
    await closedB
    assert.match(errB.join(), /wrong-pod-id/)
    assert.equal(b.bindingFailure, 'wrong-pod-id')
    a.close()
  })

  it('a peer that sends no proof is closed after the timeout, and its early messages are dropped', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const idb = await PodIdentity.generate()
      const old = new WebRTCPeerConnection({ localPodId: 'old-peer', remotePodId: idb.podId, iceServers: [] })
      const b = new WebRTCPeerConnection({ localPodId: idb.podId, remotePodId: 'old-peer', iceServers: [], identity: idb, bindingTimeoutMs: 1000 })
      const got = []
      const errB = []
      b.onMessage((m) => got.push(m))
      b.onError((e) => errB.push(e.message))
      const opened = new Promise((resolve) => old.onStateChange((s) => s === 'connected' && resolve()))
      const offer = await old.createOffer()
      await old.handleAnswer(await b.handleOffer(offer))
      await opened
      old.send({ app: 'message before any proof' })
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      assert.deepEqual(got, [])
      assert.equal(b.droppedUnbound, 1)
      assert.equal(b.state, 'connecting', 'not connected while unverified')
      mock.timers.tick(1000)
      assert.match(errB.join(), /identity binding failed: timeout/)
      assert.equal(b.state, 'closed')
    } finally {
      mock.timers.reset()
    }
  })

  it('requirePeerBinding: false accepts an older peer that sends no proof, unbound', async () => {
    const idb = await PodIdentity.generate()
    const old = new WebRTCPeerConnection({ localPodId: 'old-peer', remotePodId: idb.podId, iceServers: [] })
    const b = new WebRTCPeerConnection({ localPodId: idb.podId, remotePodId: 'old-peer', iceServers: [], identity: idb, requirePeerBinding: false })
    const got = []
    b.onMessage((m) => got.push(m))
    const connected = new Promise((resolve) => b.onStateChange((s) => s === 'connected' && resolve()))
    const offer = await old.createOffer()
    await old.handleAnswer(await b.handleOffer(offer))
    await connected
    old.send({ app: 'hello' })
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(got, [{ app: 'hello' }])
    assert.equal(b.bound, false)
    b.close(); old.close()
  })

  it('requirePeerBinding: false still closes on a proof that fails', async () => {
    const { a, b, when } = await pair({ aOpts: { requirePeerBinding: false }, bOpts: { requirePeerBinding: false }, tamperOffer: swapFingerprint, tamperAnswer: dropSignature })
    await Promise.all([when(a, 'closed'), when(b, 'closed')])
    assert.ok(a.bindingFailure === 'bad-signature' || b.bindingFailure === 'bad-signature')
  })

  it('without an identity nothing changes: no proof is sent and the state follows the channel', async () => {
    const a = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b', iceServers: [] })
    const b = new WebRTCPeerConnection({ localPodId: 'b', remotePodId: 'a', iceServers: [] })
    const connected = Promise.all([a, b].map((c) => new Promise((resolve) => c.onStateChange((s) => s === 'connected' && resolve()))))
    const offer = await a.createOffer()
    await a.handleAnswer(await b.handleOffer(offer))
    await connected
    assert.equal(a.bound, false)
    a.close(); b.close()
  })

  it('refuses an identity that is not the local pod', async () => {
    const id = await PodIdentity.generate()
    assert.throws(() => new WebRTCPeerConnection({ localPodId: 'someone-else', remotePodId: 'b', identity: id }), /identity.podId/)
    assert.throws(() => new WebRTCPeerConnection({ localPodId: id.podId, remotePodId: 'b', identity: { podId: id.podId } }), /sign/)
  })
})

// ---------------------------------------------------------------------------
// Signed session descriptions, verified before they are applied
// ---------------------------------------------------------------------------

describe('signed session descriptions: pure functions', () => {
  const OFFER = 'v=0\r\na=fingerprint:sha-256 AA:BB\r\na=ice-ufrag:one\r\n'
  const ANSWER = 'v=0\r\na=fingerprint:sha-256 CC:DD\r\na=ice-ufrag:two\r\n'
  let ida, idb
  const base = async () => {
    ida ??= await PodIdentity.generate()
    idb ??= await PodIdentity.generate()
    return { ida, idb }
  }
  const offerCheck = (ids, extra = {}) => ({ kind: 'offer', expectedPodId: ids.ida.podId, localPodId: ids.idb.podId, sdp: OFFER, ...extra })
  const answerCheck = (ids, extra = {}) => ({ kind: 'answer', expectedPodId: ids.idb.podId, localPodId: ids.ida.podId, sdp: ANSWER, offerSdp: OFFER, ...extra })

  it('an offer signed for its recipient verifies, and so does an answer to that offer', async () => {
    const ids = await base()
    const offerAuth = await signDescription(ids.ida, { kind: 'offer', peerPodId: ids.idb.podId, sdp: OFFER })
    assert.deepEqual(await verifyDescription(offerAuth, offerCheck(ids)), { ok: true })
    const answerAuth = await signDescription(ids.idb, { kind: 'answer', peerPodId: ids.ida.podId, sdp: ANSWER, offerSdp: OFFER })
    assert.deepEqual(await verifyDescription(answerAuth, answerCheck(ids)), { ok: true })
  })

  it('the transcript starts with its own domain, so it cannot be a connection-binding proof', async () => {
    const bytes = await descriptionTranscript({ kind: 'offer', signerPodId: 'a', peerPodId: 'b', sdp: OFFER })
    assert.ok(dec.decode(bytes).startsWith(DESCRIPTION_DOMAIN))
    assert.notEqual(DESCRIPTION_DOMAIN, BINDING_DOMAIN)
  })

  it('each input is bound: changing the text, the kind, the signer, the recipient or the offer answered fails', async () => {
    const ids = await base()
    const other = await PodIdentity.generate()
    const offerAuth = await signDescription(ids.ida, { kind: 'offer', peerPodId: ids.idb.podId, sdp: OFFER })
    const answerAuth = await signDescription(ids.idb, { kind: 'answer', peerPodId: ids.ida.podId, sdp: ANSWER, offerSdp: OFFER })
    const reason = async (auth, check) => (await verifyDescription(auth, check)).reason
    assert.equal(await reason(offerAuth, offerCheck(ids, { sdp: OFFER.replace('AA:BB', 'EE:EE') })), 'bad-signature')
    assert.equal(await reason(offerAuth, offerCheck(ids, { sdp: OFFER + 'a=candidate:x\r\n' })), 'bad-signature')
    assert.equal(await reason(offerAuth, offerCheck(ids, { localPodId: other.podId })), 'bad-signature') // re-addressed
    assert.equal(await reason(offerAuth, offerCheck(ids, { expectedPodId: other.podId })), 'wrong-pod-id') // a key that is not the claimed pod
    assert.equal(await reason(offerAuth, { ...offerCheck(ids), kind: 'answer', offerSdp: OFFER }), 'bad-signature') // an offer passed off as an answer
    assert.equal(await reason(answerAuth, answerCheck(ids, { offerSdp: OFFER.replace('one', 'other') })), 'bad-signature') // answer to another offer
    assert.equal(await reason(answerAuth, answerCheck(ids, { sdp: ANSWER.replace('CC:DD', 'EE:EE') })), 'bad-signature')
  })

  it('refuses unsigned, malformed and fingerprint-less input', async () => {
    const ids = await base()
    const auth = await signDescription(ids.ida, { kind: 'offer', peerPodId: ids.idb.podId, sdp: OFFER })
    assert.deepEqual(await verifyDescription(undefined, offerCheck(ids)), { ok: false, reason: 'unsigned' })
    assert.deepEqual(await verifyDescription(null, offerCheck(ids)), { ok: false, reason: 'unsigned' })
    for (const bad of [5, {}, { ...auth, v: 2 }, { ...auth, sig: 'AAAA' }, { ...auth, pk: 'AAAA' }, { ...auth, podId: 'x' }]) {
      assert.equal((await verifyDescription(bad, offerCheck(ids))).ok, false)
    }
    const noFp = 'v=0\r\na=ice-ufrag:one\r\n'
    assert.deepEqual(await verifyDescription(auth, offerCheck(ids, { sdp: noFp })), { ok: false, reason: 'no-fingerprint' })
    await assert.rejects(() => signDescription(ids.ida, { kind: 'offer', peerPodId: ids.idb.podId, sdp: noFp }), TypeError)
    await assert.rejects(() => signDescription(ids.idb, { kind: 'answer', peerPodId: ids.ida.podId, sdp: ANSWER }), TypeError) // no offer named
    await assert.rejects(() => signDescription(ids.ida, { kind: 'both', peerPodId: ids.idb.podId, sdp: OFFER }), TypeError)
  })
})

describe('signed session descriptions: WebRTCPeerConnection', () => {
  const swapSdp = (desc) => ({ ...desc, sdp: desc.sdp.replace(/a=fingerprint:.*/, `a=fingerprint:sha-256 ${Array(32).fill('EE').join(':')}`) })

  it('descriptions are signed and verified before they are applied, then the connection binds as before', async () => {
    const { a, b, when } = await pair()
    await Promise.all([when(a, 'connected'), when(b, 'connected')])
    assert.equal(a.descriptionVerified, true)
    assert.equal(b.descriptionVerified, true)
    assert.equal(a.bound && b.bound, true)
    a.close(); b.close()
  })

  it('a swapped offer is refused before it is applied: nothing reaches the RTCPeerConnection', async () => {
    const ida = await PodIdentity.generate()
    const idb = await PodIdentity.generate()
    const a = new WebRTCPeerConnection({ localPodId: ida.podId, remotePodId: idb.podId, iceServers: [], identity: ida })
    const b = new WebRTCPeerConnection({ localPodId: idb.podId, remotePodId: ida.podId, iceServers: [], identity: idb })
    const offer = swapSdp(await a.createOffer())
    const before = FakePC.applied
    await assert.rejects(() => b.handleOffer(offer), /offer .*bad-signature/)
    assert.equal(FakePC.applied, before)
    assert.equal(b.descriptionFailure, 'bad-signature')
    assert.equal(b.descriptionVerified, false)
    a.close(); b.close()
  })

  it('a swapped answer is refused before it is applied, and the offerer is not connected', async () => {
    const ida = await PodIdentity.generate()
    const idb = await PodIdentity.generate()
    const a = new WebRTCPeerConnection({ localPodId: ida.podId, remotePodId: idb.podId, iceServers: [], identity: ida })
    const b = new WebRTCPeerConnection({ localPodId: idb.podId, remotePodId: ida.podId, iceServers: [], identity: idb })
    const answer = swapSdp(await b.handleOffer(await a.createOffer()))
    const before = FakePC.applied
    await assert.rejects(() => a.handleAnswer(answer), /answer .*bad-signature/)
    assert.equal(FakePC.applied, before)
    assert.equal(a.descriptionFailure, 'bad-signature')
    assert.notEqual(a.state, 'connected')
    a.close(); b.close()
  })

  it('an answer signed for another offer is refused (it cannot be moved onto a different attempt)', async () => {
    const ida = await PodIdentity.generate()
    const idb = await PodIdentity.generate()
    const mk = () => [
      new WebRTCPeerConnection({ localPodId: ida.podId, remotePodId: idb.podId, iceServers: [], identity: ida }),
      new WebRTCPeerConnection({ localPodId: idb.podId, remotePodId: ida.podId, iceServers: [], identity: idb }),
    ]
    const [a1, b1] = mk()
    const oldAnswer = await b1.handleOffer(await a1.createOffer())
    const [a2, b2] = mk()
    await a2.createOffer()
    await assert.rejects(() => a2.handleAnswer(oldAnswer), /bad-signature/)
    a1.close(); b1.close(); a2.close(); b2.close()
  })

  it('an unsigned description (an older peer) is accepted by default, and reported unverified', async () => {
    const strip = (d) => ({ type: d.type, sdp: d.sdp })
    const { a, b, when } = await pair({ tamperOffer: strip, tamperAnswer: strip })
    await Promise.all([when(a, 'connected'), when(b, 'connected')])
    assert.equal(a.descriptionVerified, false)
    assert.equal(b.descriptionVerified, false)
    assert.equal(a.descriptionFailure, null)
    assert.equal(a.bound && b.bound, true) // the proof on the connection still binds both
    a.close(); b.close()
  })

  it('requireSignedDescription: true refuses an unsigned offer and an unsigned answer', async () => {
    const ida = await PodIdentity.generate()
    const idb = await PodIdentity.generate()
    const a = new WebRTCPeerConnection({ localPodId: ida.podId, remotePodId: idb.podId, iceServers: [], identity: ida, requireSignedDescription: true })
    const b = new WebRTCPeerConnection({ localPodId: idb.podId, remotePodId: ida.podId, iceServers: [], identity: idb, requireSignedDescription: true })
    const offer = await a.createOffer()
    const before = FakePC.applied
    await assert.rejects(() => b.handleOffer({ type: 'offer', sdp: offer.sdp }), /unsigned/)
    const answer = await b.handleOffer(offer)
    await assert.rejects(() => a.handleAnswer({ type: 'answer', sdp: answer.sdp }), /unsigned/)
    assert.equal(FakePC.applied, before + 1) // only the signed offer was applied
    assert.equal(a.descriptionFailure, 'unsigned')
    a.close(); b.close()
  })

  it('an older peer without identity is not sent anything it would mis-handle, and still connects', async () => {
    const ida = await PodIdentity.generate()
    const a = new WebRTCPeerConnection({ localPodId: ida.podId, remotePodId: 'old', iceServers: [], identity: ida, requirePeerBinding: false })
    const old = new WebRTCPeerConnection({ localPodId: 'old', remotePodId: ida.podId, iceServers: [] })
    const connected = Promise.all([a, old].map((c) => new Promise((resolve) => c.onStateChange((s) => s === 'connected' && resolve()))))
    const offer = await a.createOffer()
    assert.deepEqual(Object.keys(offer).sort(), ['auth', 'sdp', 'type']) // one additive field
    const answer = await old.handleOffer(offer)
    assert.deepEqual(Object.keys(answer).sort(), ['sdp', 'type']) // no identity, nothing added
    await a.handleAnswer(answer)
    await connected
    assert.equal(a.descriptionVerified, false)
    a.close(); old.close()
  })

  it('without an identity nothing is signed or checked', async () => {
    const a = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b', iceServers: [] })
    const offer = await a.createOffer()
    assert.deepEqual(Object.keys(offer).sort(), ['sdp', 'type'])
    assert.equal(a.descriptionVerified, null)
    a.close()
  })
})
