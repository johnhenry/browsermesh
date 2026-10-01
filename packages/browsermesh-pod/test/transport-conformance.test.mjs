/**
 * transport-conformance.test.mjs — Wires the shared TransportAdapter
 * conformance suite (test/helpers/transport-conformance.mjs) up for every
 * TransportAdapter this package ships.
 *
 * Registered here: BroadcastChannelTransport, EventEmitterTransport,
 * NullTransport (with `delivers: false`, since it is an intentional no-op).
 *
 * Adding a new adapter is ONE call to runTransportConformance(). For
 * example, when WebSocketTransport lands (a sibling WP, on another branch):
 *
 *   import { WebSocketTransport } from '../src/ws-transport.mjs'
 *
 *   runTransportConformance(
 *     'WebSocketTransport',
 *     () => new WebSocketTransport({ url: 'ws://fake', podId: 'p', WebSocket: FakeWebSocket }),
 *     { makePair: () => makeWebSocketTransportPair() },
 *   )
 *
 * — backed by a fake WebSocket constructor/relay the same way
 * BroadcastChannelTransport below is backed by a fake BroadcastChannel.
 * Nothing in transport-conformance.mjs itself needs to change.
 */

import { runTransportConformance } from './helpers/transport-conformance.mjs'
import { BroadcastChannelTransport, EventEmitterTransport, NullTransport } from '../src/transport.mjs'

// ---------------------------------------------------------------------------
// Fake BroadcastChannel — same pattern as test/transport.test.mjs's
// StubBroadcastChannel: an in-process registry keyed by channel name,
// delivering to every OTHER same-name instance via a microtask (never
// synchronously inside postMessage(), matching the real BroadcastChannel).
// ---------------------------------------------------------------------------

const channels = new Map()

class FakeBroadcastChannel {
  constructor(name) {
    this.name = name
    this.onmessage = null
    this._closed = false
    if (!channels.has(name)) channels.set(name, new Set())
    channels.get(name).add(this)
  }
  postMessage(data) {
    if (this._closed) return
    const peers = channels.get(this.name)
    if (!peers) return
    for (const ch of peers) {
      if (ch !== this && !ch._closed && ch.onmessage) {
        Promise.resolve().then(() => {
          if (!ch._closed && ch.onmessage) ch.onmessage({ data })
        })
      }
    }
  }
  close() {
    this._closed = true
    const set = channels.get(this.name)
    if (set) set.delete(this)
  }
}

let channelCounter = 0
function uniqueChannelName() {
  channelCounter += 1
  return `conformance-ch-${channelCounter}`
}

// ---------------------------------------------------------------------------
// BroadcastChannelTransport
// ---------------------------------------------------------------------------

runTransportConformance(
  'BroadcastChannelTransport',
  () => new BroadcastChannelTransport(uniqueChannelName(), FakeBroadcastChannel),
  {
    makePair: () => {
      const name = uniqueChannelName()
      return {
        a: new BroadcastChannelTransport(name, FakeBroadcastChannel),
        b: new BroadcastChannelTransport(name, FakeBroadcastChannel),
        c: new BroadcastChannelTransport(name, FakeBroadcastChannel),
      }
    },
  },
)

// ---------------------------------------------------------------------------
// EventEmitterTransport
// ---------------------------------------------------------------------------

runTransportConformance(
  'EventEmitterTransport',
  () => new EventEmitterTransport(),
  {
    makePair: () => {
      const bus = EventEmitterTransport.createBus()
      return {
        a: new EventEmitterTransport(bus),
        b: new EventEmitterTransport(bus),
        c: new EventEmitterTransport(bus),
      }
    },
  },
)

// ---------------------------------------------------------------------------
// NullTransport — intentionally a no-op: delivers() nothing, so the shared
// suite swaps in "never delivers" / "always-ready" assertions instead of
// the stateful open/close/delivery contract the other two adapters follow.
// ---------------------------------------------------------------------------

runTransportConformance(
  'NullTransport',
  () => new NullTransport(),
  {
    delivers: false,
    makePair: () => ({
      a: new NullTransport(),
      b: new NullTransport(),
    }),
  },
)
