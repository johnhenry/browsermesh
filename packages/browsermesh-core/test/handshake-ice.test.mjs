// HandshakeCoordinator ICE configuration (#248): the coordinator must hand the
// transport factory usable iceServers / iceTransportPolicy on the offer side
// (connectToPeer), the answer side (acceptConnection) and connectViaToken.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { HandshakeCoordinator } from '../src/handshake.mjs'
import { TransportFactory } from '@johnhenry/browsermesh-transport'

const STUN = [{ urls: 'stun:stun.example.test:3478' }]
const TURN = [{ urls: 'turn:turn.example.test:3478', username: 'u', credential: 'c' }]
const OTHER_TURN = [{ urls: 'turns:other.example.test:5349', username: 'u2', credential: 'c2' }]

// podLo < podHi, so podLo is the designated offerer in connectToPeer().
const LO = 'pod-aaaa'
const HI = 'pod-bbbb'

function stubSignaler() {
  return {
    onOffer() {},
    sendOffer() {}, sendAnswer() {}, sendIceCandidate() {},
    onAnswer() {}, onIceCandidate() {},
    connected: true,
  }
}

/** Factory that records the options each create()/negotiate() receives. */
function recordingFactory() {
  const rec = { negotiate: [], create: [] }
  const mk = (type, opts) => ({
    type,
    opts,
    async connect() {},
    async handleOffer() {},
    onClose() {},
  })
  return {
    rec,
    async negotiate(localPodId, remotePodId, signaler, endpointOpts) {
      rec.negotiate.push(endpointOpts)
      return mk('webrtc', endpointOpts?.webrtc)
    },
    async create(type, opts) {
      rec.create.push({ type, opts })
      return mk(type, opts)
    },
  }
}

const iceOf = (webrtcOpts) => ({
  iceServers: webrtcOpts.iceServers,
  iceTransportPolicy: webrtcOpts.iceTransportPolicy,
})

describe('HandshakeCoordinator ICE config (#248)', () => {
  it('connectToPeer forwards constructor iceServers/iceTransportPolicy to the factory', async () => {
    const factory = recordingFactory()
    const coord = new HandshakeCoordinator({
      localPodId: LO, signalingClient: stubSignaler(), transportFactory: factory,
      iceServers: TURN, iceTransportPolicy: 'relay',
    })
    await coord.connectToPeer(HI)
    const w = factory.rec.negotiate[0].webrtc
    assert.deepEqual(iceOf(w), { iceServers: TURN, iceTransportPolicy: 'relay' })
    assert.deepEqual(w.config.iceServers, TURN)
  })

  it('acceptConnection forwards constructor iceServers/iceTransportPolicy to factory.create', async () => {
    const factory = recordingFactory()
    const coord = new HandshakeCoordinator({
      localPodId: HI, signalingClient: stubSignaler(), transportFactory: factory,
      iceServers: TURN, iceTransportPolicy: 'relay',
    })
    await coord.acceptConnection(LO, { sdp: 'offer' })
    const { type, opts } = factory.rec.create[0]
    assert.equal(type, 'webrtc')
    assert.deepEqual(iceOf(opts), { iceServers: TURN, iceTransportPolicy: 'relay' })
    assert.equal(opts.remotePodId, LO)
  })

  it('connectViaToken forwards constructor defaults, token iceServers win over them', async () => {
    const f1 = recordingFactory()
    const c1 = new HandshakeCoordinator({
      localPodId: LO, signalingClient: stubSignaler(), transportFactory: f1,
      iceServers: TURN, iceTransportPolicy: 'relay',
    })
    await c1.connectViaToken({ podId: HI })
    assert.deepEqual(iceOf(f1.rec.negotiate[0].webrtc), { iceServers: TURN, iceTransportPolicy: 'relay' })

    const f2 = recordingFactory()
    const c2 = new HandshakeCoordinator({
      localPodId: LO, signalingClient: stubSignaler(), transportFactory: f2,
      iceServers: TURN, iceTransportPolicy: 'relay',
    })
    await c2.connectViaToken({ podId: HI, iceServers: OTHER_TURN })
    assert.deepEqual(iceOf(f2.rec.negotiate[0].webrtc), { iceServers: OTHER_TURN, iceTransportPolicy: 'relay' })
  })

  it('per-call values override the constructor defaults on all three paths', async () => {
    const f = recordingFactory()
    const offerer = new HandshakeCoordinator({
      localPodId: LO, signalingClient: stubSignaler(), transportFactory: f,
      iceServers: STUN, iceTransportPolicy: 'all',
    })
    await offerer.connectToPeer(HI, { iceServers: TURN, iceTransportPolicy: 'relay' })
    assert.deepEqual(iceOf(f.rec.negotiate[0].webrtc), { iceServers: TURN, iceTransportPolicy: 'relay' })

    const answerer = new HandshakeCoordinator({
      localPodId: HI, signalingClient: stubSignaler(), transportFactory: f,
      iceServers: STUN, iceTransportPolicy: 'all',
    })
    await answerer.acceptConnection(LO, {}, { iceServers: TURN, iceTransportPolicy: 'relay' })
    assert.deepEqual(iceOf(f.rec.create[0].opts), { iceServers: TURN, iceTransportPolicy: 'relay' })

    await offerer.connectViaToken({ podId: 'pod-cccc', iceServers: STUN }, undefined,
      { iceServers: OTHER_TURN, iceTransportPolicy: 'relay' })
    assert.deepEqual(iceOf(f.rec.negotiate[1].webrtc), { iceServers: OTHER_TURN, iceTransportPolicy: 'relay' })
  })

  it('with no ICE config anywhere, nothing new is forced on the transport (defaults preserved)', async () => {
    const f = recordingFactory()
    const offerer = new HandshakeCoordinator({ localPodId: LO, signalingClient: stubSignaler(), transportFactory: f })
    await offerer.connectToPeer(HI)
    const w = f.rec.negotiate[0].webrtc
    assert.equal('iceServers' in w, false)
    assert.equal('iceTransportPolicy' in w, false)
    assert.deepEqual(w.config.iceServers, [])

    const answerer = new HandshakeCoordinator({ localPodId: HI, signalingClient: stubSignaler(), transportFactory: f })
    await answerer.acceptConnection(LO, {})
    assert.equal('iceServers' in f.rec.create[0].opts, false)
    assert.equal('iceTransportPolicy' in f.rec.create[0].opts, false)
  })

  it('explicit opts.endpoints is still passed through untouched', async () => {
    const f = recordingFactory()
    const coord = new HandshakeCoordinator({
      localPodId: LO, signalingClient: stubSignaler(), transportFactory: f, iceServers: TURN,
    })
    const endpoints = { webrtc: { iceServers: STUN } }
    await coord.connectToPeer(HI, { endpoints })
    assert.equal(f.rec.negotiate[0], endpoints)
  })

  describe('with a real TransportFactory({ iceTransportPolicy: "relay" })', () => {
    // Real factory + real WebRTCTransport construction (where the relay/TURN
    // check lives); only the network-touching connect()/handleOffer() are stubbed.
    function relayFactory() {
      const real = new TransportFactory({
        iceTransportPolicy: 'relay', preferredOrder: ['webrtc'], _RTCPeerConnection: function () {},
      })
      const stub = (t) => { t.connect = async () => {}; t.handleOffer = async () => {}; return t }
      return {
        negotiate: async (...a) => stub(await real.negotiate(...a)),
        create: async (...a) => stub(await real.create(...a)),
      }
    }

    it('offer, answer and token paths no longer throw when TURN is configured on the coordinator', async () => {
      const offerer = new HandshakeCoordinator({
        localPodId: LO, signalingClient: stubSignaler(), transportFactory: relayFactory(), iceServers: TURN,
      })
      assert.equal((await offerer.connectToPeer(HI)).transport.type, 'webrtc')

      const answerer = new HandshakeCoordinator({
        localPodId: HI, signalingClient: stubSignaler(), transportFactory: relayFactory(), iceServers: TURN,
      })
      assert.equal((await answerer.acceptConnection(LO, {})).transport.type, 'webrtc')

      const viaToken = new HandshakeCoordinator({
        localPodId: LO, signalingClient: stubSignaler(), transportFactory: relayFactory(), iceServers: TURN,
      })
      assert.equal((await viaToken.connectViaToken({ podId: HI })).transport.type, 'webrtc')
    })

    it('without any ICE config, relay still rejects (control)', async () => {
      const answerer = new HandshakeCoordinator({
        localPodId: HI, signalingClient: stubSignaler(), transportFactory: relayFactory(),
      })
      await assert.rejects(answerer.acceptConnection(LO, {}), /turn:/)
    })
  })
})
