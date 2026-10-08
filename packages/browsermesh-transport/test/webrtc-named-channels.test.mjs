// Run with: node --import ./test/_setup-globals.mjs --test test/webrtc-named-channels.test.mjs
// #115: additional named data channels over one already-negotiated connection.
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

class MockDC {
  constructor(label, opts) { this.label = label; this.opts = opts; this.readyState = 'open'; this.sent = [] }
  send(d) { this.sent.push(d) }
  close() { this.readyState = 'closed'; this.onclose?.() }
}
let pcs = []
class MockPC {
  constructor() { this.channels = []; pcs.push(this); this.connectionState = 'new' }
  createDataChannel(label, opts) { const dc = new MockDC(label, opts); this.channels.push(dc); return dc }
  async createOffer() { return { type: 'offer', sdp: 'o' } }
  async createAnswer() { return { type: 'answer', sdp: 'a' } }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  get remoteDescription() { return null }
  addIceCandidate() {}
  close() {}
}
globalThis.RTCPeerConnection = MockPC

const { WebRTCPeerConnection } = await import('../src/webrtc.mjs')

async function offerer() {
  const c = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
  await c.createOffer()
  return c
}

describe('named data channels (#115)', () => {
  beforeEach(() => { pcs = [] })

  it('openChannel creates a labelled channel on the existing RTCPeerConnection with its own options', async () => {
    const c = await offerer()
    const before = pcs.length
    c.openChannel('telemetry', { ordered: false, maxRetransmits: 0 })
    assert.equal(pcs.length, before, 'no new RTCPeerConnection')
    const dc = pcs[0].channels.find((d) => d.label === 'mesh-x:telemetry')
    assert.deepEqual(dc.opts, { ordered: false, maxRetransmits: 0 })
    assert.deepEqual(c.channels, ['control', 'bulk', 'telemetry'])
  })

  it('send({ channel }) goes to that channel only', async () => {
    const c = await offerer()
    c.openChannel('telemetry')
    c.send({ n: 1 }, { channel: 'telemetry' })
    const [control, bulk, tel] = pcs[0].channels
    assert.equal(tel.sent.length, 1)
    assert.equal(control.sent.length + bulk.sent.length, 0)
  })

  it('sending on an unopened or closed named channel throws (no silent fallback)', async () => {
    const c = await offerer()
    assert.throws(() => c.send('x', { channel: 'nope' }), /Unknown channel/)
    c.openChannel('t')
    c.closeChannel('t')
    assert.throws(() => c.send('x', { channel: 't' }), /Unknown channel/)
    assert.deepEqual(c.channels, ['control', 'bulk'])
  })

  it('validates names and refuses reserved ones and duplicates', async () => {
    const c = await offerer()
    for (const bad of ['', 'control', 'bulk', 'a b', 'x'.repeat(65), 5]) {
      assert.throws(() => c.openChannel(bad), /channel name/i, String(bad))
    }
    c.openChannel('ok')
    assert.throws(() => c.openChannel('ok'), /already open/)
  })

  it('requires a peer connection', () => {
    const c = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
    assert.throws(() => c.openChannel('t'), /No peer connection/)
  })

  it('messages from a named channel reach onMessage with the channel name as 2nd arg', async () => {
    const c = await offerer()
    const got = []
    c.onMessage((d, ch) => got.push([d, ch]))
    const dc = c.openChannel('telemetry')
    dc.onmessage({ data: JSON.stringify({ a: 1 }) })
    pcs[0].channels[0].onmessage({ data: 'hi' })
    assert.deepEqual(got, [[{ a: 1 }, 'telemetry'], ['hi', 'control']])
  })

  it('the answerer adopts a remote-opened named channel without disturbing control', async () => {
    const c = new WebRTCPeerConnection({ localPodId: 'b', remotePodId: 'a' })
    await c.handleOffer({ type: 'offer', sdp: 'o' })
    const pc = pcs[0]
    const control = new MockDC('mesh'); const x = new MockDC('mesh-x:telemetry')
    pc.ondatachannel({ channel: control })
    pc.ondatachannel({ channel: x })
    assert.deepEqual(c.channels, ['control', 'telemetry'])
    c.send('hi', { channel: 'telemetry' })
    assert.equal(x.sent.length, 1)
    assert.equal(control.sent.length, 0)
  })

  it('a named channel closing does not tear the connection down; close() closes them all', async () => {
    const c = await offerer()
    const dc = c.openChannel('t')
    dc.close()
    assert.notEqual(c.state, 'closed')
    assert.deepEqual(c.channels, ['control', 'bulk'])
    c.openChannel('u')
    c.close()
    assert.deepEqual(c.channels, [])
  })
})
