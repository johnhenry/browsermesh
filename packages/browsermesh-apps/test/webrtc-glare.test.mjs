// Run with: node --import ./test/_setup-globals.mjs --test test/webrtc-glare.test.mjs
//
// Two peers that dial each other at the same moment (glare) must end with ONE connection, quickly, and both dials must
// come back with it. The rule: the lower pod id's offer wins, the other side drops its own offer and answers. A peer
// that does not say it follows the rule (an older release) is assumed to yield, as an older release always did, so the
// newer side's offer always wins against it. Every connection also gets exactly one transport adapter, however many
// times it is handed out, so a peer that starts over on a connection it already had is not wired in twice.
//
// The "connections" are an in-memory model of the offer/answer exchange: an answer only applies to the offer it answers,
// the way a real RTCPeerConnection refuses a stale one. Nothing waits on the wall clock; a guard timer only turns a
// hang into a failure.
import { describe, it, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'

import { createWebRTCTransportFactory, GLARE_RESEND_MS } from '../src/webrtc-negotiator.mjs'

afterEach(() => mock.timers.reset())

const settle = () => new Promise((r) => setImmediate(r))
const guard = (promise, what, ms = 4000) => {
  let timer
  const stop = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`hung: ${what}`)), ms) })
  return Promise.race([promise, stop]).finally(() => clearTimeout(timer))
}

/** One side's view of one connection. `world` links the two sides so an applied answer opens both. */
function fakeConn(world, local, remote) {
  const stateCbs = []
  const closeCbs = []
  let seq = 0
  const conn = {
    remotePodId: remote,
    isOpen: false,
    state: 'new',
    bindingFailure: null,
    pc: null, // { role: 'offerer'|'answerer', offer }
    onIceCandidate() {},
    onClose(cb) { closeCbs.push(cb) },
    onError() {},
    onMessage() {},
    onStateChange(cb) { stateCbs.push(cb) },
    send() {},
    close() { conn.isOpen = false; conn.state = 'closed'; for (const cb of stateCbs) cb('closed'); for (const cb of closeCbs) cb() },
    async createOffer() {
      seq += 1
      const offer = `offer:${local}:${seq}`
      conn.pc = { role: 'offerer', offer }
      conn.isOpen = false
      return { type: 'offer', sdp: offer }
    },
    async handleOffer(offer) {
      world.answered.push(`${local} answered ${offer.sdp}`)
      // A renegotiation (an ICE restart) keeps the channel and the state it has; the answer says so (as the real connection's does).
      if (conn.renegotiates) return { type: 'answer', sdp: `answer:${offer.sdp}`, renegotiation: true }
      // A fresh offer replaces whatever this side had (that is what the real connection does).
      conn.pc = { role: 'answerer', offer: offer.sdp }
      conn.isOpen = false
      return { type: 'answer', sdp: `answer:${offer.sdp}` }
    },
    async handleAnswer(answer) {
      if (conn.pc?.role !== 'offerer' || answer.sdp !== `answer:${conn.pc.offer}`) throw new Error(`stale answer ${answer.sdp} for ${conn.pc?.role}:${conn.pc?.offer}`)
      conn.pc.answered = true
      world.open(local, remote)
    },
    setOpen() { conn.isOpen = true; conn.state = 'connected'; for (const cb of stateCbs) cb('connected') },
  }
  return conn
}

/** An in-memory world of peers: signalling that delivers on the next turn, and connections that open when an answer is applied. */
function world() {
  const w = { peers: new Map(), answered: [], log: [] }
  w.open = (a, b) => { w.peers.get(a).conns.get(b)?.setOpen(); w.peers.get(b).conns.get(a)?.setOpen() }
  w.add = (id, { legacy = false } = {}) => {
    const handlers = { offer: [], answer: new Set(), ice: [] }
    const conns = new Map()
    const incoming = []
    const meshManager = {
      async connectToPeer(p) { if (!conns.has(p)) conns.set(p, fakeConn(w, id, p)); return conns.get(p) },
      getConnection(p) { return conns.get(p) ?? null },
    }
    const signaling = {
      send(type, to, payload, connectionId) {
        const sent = legacy && type === 'webrtc-offer' ? { type: payload.type, sdp: payload.sdp } : payload
        w.log.push(`${id}->${to} ${type}${sent.glare ? ' (glare)' : ''}`)
        const target = w.peers.get(to) // a peer that is not there when the message is sent never gets it
        setImmediate(() => {
          if (!target) return
          if (type === 'webrtc-offer') for (const cb of target.handlers.offer) cb(id, sent, connectionId)
          else if (type === 'webrtc-answer') for (const cb of [...target.handlers.answer]) cb(id, sent, connectionId)
        })
      },
      onOffer(cb) { handlers.offer.push(cb) },
      onAnswer(cb) { handlers.answer.add(cb); return () => handlers.answer.delete(cb) },
      onIce() {},
    }
    const peer = { id, handlers, conns, incoming, meshManager, signaling }
    if (legacy) {
      // What every release before the rule does: an inbound offer is answered whatever this side has out (the connection
      // replaces its own offer), and a dial sends an offer with no marker and waits for an answer to it.
      handlers.offer.length = 0
      signaling.onOffer(async (from, offer, connectionId) => {
        const conn = await meshManager.connectToPeer(from)
        signaling.send('webrtc-answer', from, await conn.handleOffer(offer), connectionId)
      })
      peer.factory = async (remote) => {
        const conn = await meshManager.connectToPeer(remote)
        signaling.send('webrtc-offer', remote, await conn.createOffer(), 'default')
        await new Promise(() => {}) // never answered in glare: the older release times out after answerTimeoutMs
      }
    } else {
      peer.factory = createWebRTCTransportFactory({ localPodId: id, meshManager, signaling, onIncomingConnection: (from, adapter, connectionId, info) => incoming.push({ from, adapter, connectionId, info }) })
    }
    w.peers.set(id, peer)
    return peer
  }
  return w
}

describe('glare: two peers dial each other at once', () => {
  it('lower pod id wins: both dials come back with the one connection, and only the winner\'s offer was answered', async () => {
    const w = world()
    const a = w.add('aaa')
    const b = w.add('bbb')
    const [ta, tb] = await guard(Promise.all([a.factory('bbb'), b.factory('aaa')]), 'both dials')
    assert.equal(ta.state, 'connected')
    assert.equal(tb.state, 'connected')
    assert.equal(a.conns.get('bbb').isOpen, true)
    assert.equal(b.conns.get('aaa').isOpen, true)
    assert.equal(a.conns.get('bbb').pc.role, 'offerer')
    assert.equal(b.conns.get('aaa').pc.role, 'answerer')
    assert.deepEqual(w.answered, ['bbb answered offer:aaa:1'])
  })

  it('the winner is the lower pod id whichever side calls first', async () => {
    const w = world()
    const a = w.add('aaa')
    const b = w.add('bbb')
    const second = b.factory('aaa')
    const first = a.factory('bbb')
    await guard(Promise.all([first, second]), 'both dials')
    assert.deepEqual(w.answered, ['bbb answered offer:aaa:1'])
  })

  it('every connection has one adapter: the dial that yielded and the connection it answered share it', async () => {
    const w = world()
    const a = w.add('aaa')
    const b = w.add('bbb')
    const [, tb] = await guard(Promise.all([a.factory('bbb'), b.factory('aaa')]), 'both dials')
    await settle()
    assert.equal(b.incoming.length >= 1, true)
    assert.ok(b.incoming.every((i) => i.adapter === tb), 'the adapter handed to the node as an incoming session is the one the dial returned')
  })

  it('the offer carries the glare marker an older peer ignores', async () => {
    const w = world()
    const a = w.add('aaa')
    w.add('bbb')
    await guard(a.factory('bbb'), 'dial')
    assert.ok(w.log.includes('aaa->bbb webrtc-offer (glare)'), w.log.join('\n'))
  })

  it('no glare, no change: a lone dial and a lone inbound offer behave as before', async () => {
    const w = world()
    const a = w.add('aaa')
    const b = w.add('bbb')
    const t = await guard(a.factory('bbb'), 'dial')
    assert.equal(t.state, 'connected')
    await settle()
    assert.equal(b.incoming.length, 1)
    assert.deepEqual(w.answered, ['bbb answered offer:aaa:1'])
  })
})

describe('glare against a peer that does not know the rule (an older release)', () => {
  it('our offer wins whatever the ids say, and the older peer answers it as it always did', async () => {
    for (const [mine, theirs] of [['zzz', 'aaa'], ['aaa', 'zzz']]) {
      const w = world()
      const ours = w.add(mine)
      const old = w.add(theirs, { legacy: true })
      // The older peer's whole behaviour in glare: it answers an inbound offer even while its own is out (the fake's handleOffer
      // replaces its offer), and its own dial then never gets an answer.
      const theirDial = old.factory(mine)
      theirDial.catch(() => {})
      const ourDial = ours.factory(theirs)
      const t = await guard(ourDial, `our dial against ${theirs}`)
      assert.equal(t.state, 'connected')
      assert.equal(ours.conns.get(theirs).pc.role, 'offerer')
      assert.deepEqual(w.answered, [`${theirs} answered offer:${mine}:1`], `${mine} against ${theirs}`)
    }
  })
})

describe('an offer that went nowhere is not a reason to ignore the one that comes back', () => {
  // The peer was not there when this side first dialled (its offer was dropped), so nothing will ever answer that offer. When
  // the peer comes up and dials, this side's offer is still "out": the side that wins sends it again, so the other side has it.
  const turns = async (n = 8) => { for (let i = 0; i < n; i++) await settle() }
  for (const [early, late, why] of [['aaa', 'bbb', 'the early dialler has the lower id'], ['bbb', 'aaa', 'the early dialler has the higher id']]) {
    it(`both end up linked (${why})`, async () => {
      mock.timers.enable({ apis: ['setTimeout'] })
      const w = world()
      const first = w.add(early)
      const earlyDial = first.factory(late) // nobody there: the offer is dropped
      await turns()
      const second = w.add(late)
      const lateDial = second.factory(early)
      await turns()
      mock.timers.tick(GLARE_RESEND_MS) // no answer came: the winner's offer goes out again
      const [t1, t2] = await Promise.all([earlyDial, lateDial])
      assert.equal(t1.state, 'connected')
      assert.equal(t2.state, 'connected')
      assert.equal(first.conns.get(late).isOpen && second.conns.get(early).isOpen, true)
    })
  }

  it('a glare that is a true one sends nothing twice: the answer is in before the resend would run', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const w = world()
    const a = w.add('aaa')
    const b = w.add('bbb')
    const dials = Promise.all([a.factory('bbb'), b.factory('aaa')])
    await turns()
    mock.timers.tick(GLARE_RESEND_MS * 2)
    await dials
    assert.deepEqual(w.answered, ['bbb answered offer:aaa:1'])
    assert.equal(w.log.filter((l) => l.startsWith('aaa->bbb webrtc-offer')).length, 1)
  })

  it('against an older peer that comes up later: our offer is sent again and the older peer answers it', async () => {
    for (const [mine, theirs] of [['zzz', 'aaa'], ['aaa', 'zzz']]) {
      mock.timers.enable({ apis: ['setTimeout'] })
      const w = world()
      const ours = w.add(mine)
      const ourDial = ours.factory(theirs) // the older peer is not there yet
      await turns()
      const old = w.add(theirs, { legacy: true })
      old.factory(mine).catch(() => {})
      await turns()
      mock.timers.tick(GLARE_RESEND_MS)
      const t = await ourDial
      assert.equal(t.state, 'connected')
      assert.equal(ours.conns.get(theirs).pc.role, 'offerer')
      mock.timers.reset()
    }
  })
})

describe('a peer that starts over on a connection this side still holds', () => {
  it('is wired in once: the same adapter is handed to the node again, not a second one', async () => {
    const w = world()
    const a = w.add('aaa')
    const b = w.add('bbb')
    await guard(a.factory('bbb'), 'first dial')
    await settle()
    assert.equal(b.incoming.length, 1)
    // bbb's page started over: a fresh offer arrives on the connection bbb still has open at aaa's end... (here: at bbb's end, from aaa)
    const conn = b.conns.get('aaa')
    const answering = b.handlers.offer[0]('aaa', { type: 'offer', sdp: 'offer:aaa:restart' }, 'default')
    await settle()
    conn.setOpen()
    await guard(answering, 'the answer to the restart')
    assert.equal(b.incoming.length >= 2, true)
    assert.equal(new Set(b.incoming.map((i) => i.adapter)).size, 1, 'one adapter for the one connection')
  })

  it('says so when it hands the connection out: `restarted` is false for a first connection and true for a peer that started over on one held open', async () => {
    const w = world()
    const a = w.add('aaa')
    const b = w.add('bbb')
    await guard(a.factory('bbb'), 'first dial')
    await settle()
    assert.equal(b.incoming.length, 1)
    assert.deepEqual([b.incoming[0].connectionId, b.incoming[0].info], ['default', { restarted: false }], 'the first connection is not a restart')
    const conn = b.conns.get('aaa')
    assert.equal(conn.isOpen, true, 'the connection is held open when the fresh offer arrives')
    const answering = b.handlers.offer[0]('aaa', { type: 'offer', sdp: 'offer:aaa:restart' }, 'default')
    await settle()
    conn.setOpen()
    await guard(answering, 'the answer to the restart')
    assert.deepEqual(b.incoming.at(-1).info, { restarted: true })
  })

  it('a connection that was closed is not a restart: the peer\'s next offer is a new connection', async () => {
    const w = world()
    const a = w.add('aaa')
    const b = w.add('bbb')
    await guard(a.factory('bbb'), 'first dial')
    await settle()
    b.conns.get('aaa').close()
    const conn = b.conns.get('aaa')
    const answering = b.handlers.offer[0]('aaa', { type: 'offer', sdp: 'offer:aaa:again' }, 'default')
    await settle()
    conn.setOpen()
    await guard(answering, 'the answer')
    assert.deepEqual(b.incoming.at(-1).info, { restarted: false })
  })

  it('a connection handed out and still held is a restart even when its channel is no longer open: the close that follows is never seen once the connection is swapped', async () => {
    const w = world()
    const a = w.add('aaa')
    const b = w.add('bbb')
    await guard(a.factory('bbb'), 'first dial')
    await settle()
    const conn = b.conns.get('aaa')
    // The pod on the other end went away without a close this side has seen yet: the channel is closing (not open), the
    // connection is neither closed nor dropped, and what was handed to the node (the adapter, the link over it) is live.
    conn.isOpen = false
    assert.notEqual(b.incoming[0].adapter.state, 'closed')
    const answering = b.handlers.offer[0]('aaa', { type: 'offer', sdp: 'offer:aaa:after-a-silent-end' }, 'default')
    await settle()
    conn.setOpen()
    await guard(answering, 'the answer')
    assert.deepEqual(b.incoming.at(-1).info, { restarted: true }, 'what ran over the old connection is over, so the node is told')
  })

  it('a connection that was never handed to the node is not a restart, whatever its state', async () => {
    const w = world()
    const b = w.add('bbb')
    const conn = await b.meshManager.connectToPeer('aaa') // wired, never opened, never handed out
    const answering = b.handlers.offer[0]('aaa', { type: 'offer', sdp: 'offer:aaa:first' }, 'default')
    await settle()
    conn.setOpen()
    await guard(answering, 'the answer')
    assert.deepEqual(b.incoming.at(-1).info, { restarted: false })
  })

  it('a renegotiation of an open connection (an ICE restart) is not a restart: the channel and what runs over it carry on', async () => {
    const w = world()
    const a = w.add('aaa')
    const b = w.add('bbb')
    await guard(a.factory('bbb'), 'first dial')
    await settle()
    const conn = b.conns.get('aaa')
    conn.renegotiates = true
    const answering = b.handlers.offer[0]('aaa', { type: 'offer', sdp: 'offer:aaa:ice-restart' }, 'default')
    await guard(answering, 'the answer to the renegotiation')
    assert.equal(conn.isOpen, true)
    assert.deepEqual(b.incoming.at(-1).info, { restarted: false })
  })
})
