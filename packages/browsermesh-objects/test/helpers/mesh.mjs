/**
 * Test helpers: three pods on a simulated in-process bus, each with its own
 * PeerRegistry (default deny) and a protocol service; an app with the shapes
 * the object layer treats differently (plain values, an emitter, a class
 * instance that comes back as a handle, a function that takes a callback).
 */
import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import { MeshPeerManager, TrustGraph, MeshACL } from '@johnhenry/browsermesh-core'
import { attachService, createMeshProtocolService, PeerRegistry } from '@johnhenry/browsermesh-apps'

/** A clock whose timers fire only when a test advances it (PeerRegistry's `clock`). */
export function fakeClock(start = 1_000_000) {
  let t = start
  let seq = 0
  const timers = new Map()
  return {
    now: () => t,
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { fn, at: t + ms }); return id },
    clearTimeout(id) { timers.delete(id) },
    advance(ms) {
      const target = t + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        t = due[1].at
        timers.delete(due[0])
        due[1].fn()
      }
      t = target
    },
  }
}

export async function createNodes(count, { clock } = {}) {
  const nodes = new Map()
  for (let i = 0; i < count; i++) {
    const { podId } = await PodIdentity.generate()
    const listeners = new Set()
    const node = {
      podId,
      listeners,
      onIncomingData(cb) { listeners.add(cb); return () => listeners.delete(cb) },
      async sendTo(to, data) {
        const target = nodes.get(to)
        if (!target) throw new Error('unreachable peer')
        const text = JSON.stringify(data) // a real transport carries JSON text
        queueMicrotask(() => { for (const cb of target.listeners) cb(podId, text) })
      },
    }
    node.registry = new PeerRegistry({ localPodId: podId, peerManager: new MeshPeerManager({}), trustGraph: new TrustGraph(), acl: new MeshACL({ owner: podId }), ...(clock ? { clock } : {}) })
    nodes.set(podId, node)
  }
  return [...nodes.values()]
}

/** alice, bob (the host) and eve, each with a protocol service. `channelOptions` are the mesh channel's limits. */
export async function threePods({ channelOptions, clock } = {}) {
  const [alice, bob, eve] = await createNodes(3, { clock })
  const svc = (node) => attachService(node, undefined, createMeshProtocolService(channelOptions))
  const a = svc(alice)
  const b = svc(bob)
  const e = svc(eve)
  return { alice, bob, eve, a, b, e, teardown() { a.teardown(); b.teardown(); e.teardown() } }
}

export class Cart {
  constructor() { this.items = [1, 2, 3]; this.note = 'private'; this.listeners = new Set() }
  add(n) { this.items.push(n); return this.items.length }
  // An emitter-style source: through a handle, a subscription to it is an event through a handle (wsh 0.51).
  on(type, fn) { if (type === 'changed') this.listeners.add(fn) }
  off(type, fn) { if (type === 'changed') this.listeners.delete(fn) }
  emit(type, ...args) { for (const fn of [...this.listeners]) fn(...args) }
}

/** The host's object graph. */
export function makeApp() {
  const listeners = new Map()
  const stubs = new Set()
  const app = {
    title: 'inbox',
    secret: 'not for the wire',
    text: 'y'.repeat(3000),
    counter: { value: 3, inc(n = 1) { app.counter.value += n; return app.counter.value } },
    bytes: () => new Uint8Array(150_000).map((_, i) => i % 251),
    // An emitter-style event source: on / off.
    bus: {
      on(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn) },
      off(type, fn) { listeners.get(type)?.delete(fn) },
    },
    // A class instance: on a root that opted in to handles it comes back as an opaque handle.
    cart: new Cart(),
    makeCart: () => new Cart(),
    // Takes a callback: the host receives a one-way stub.
    subscribe(fn) { stubs.add(fn); return stubs.size },
    // Test hooks on the host side (not reachable: no allow-list entry names them).
    emit(type, ...args) { for (const fn of [...(listeners.get(type) ?? [])]) fn(...args) },
    listenerCount: (type) => listeners.get(type)?.size ?? 0,
    fire(...args) { return [...stubs].map((stub) => stub(...args)) },
    stubCount: () => stubs.size,
  }
  return app
}

export const allow = {
  get: ['app.title', 'app.text', 'app.counter.**', 'app.cart', 'app.cart.items', 'app.cart.items.length', 'app.makeCart().items', 'app.makeCart().items.length'],
  call: ['app.counter.inc', 'app.bytes', 'app.makeCart', 'app.makeCart().add', 'app.cart.add', 'app.subscribe(callback)'],
  set: ['app.counter.value'],
  on: ['app.bus@ping', 'app.bus@tick', 'app.cart@changed'],
}

/** Wait for a condition without a wall-clock budget in the assertion: it is the test's own timeout that ends a hang. */
export async function until(condition) {
  for (let i = 0; !condition(); i++) {
    await new Promise((resolve) => setImmediate(resolve))
    if (i > 200_000) throw new Error('until: condition never became true')
  }
}

/** A channel whose reader can be held: while held, inbound messages are not handed on and no credit goes back. */
export function holdable(channel) {
  let gate = Promise.resolve()
  let release = () => {}
  const proxy = new Proxy(channel, {
    get(target, key) {
      if (key === 'onMessage') return (cb) => target.onMessage(async (message, ctx) => { await gate; return cb(message, ctx) })
      return Reflect.get(target, key)
    },
  })
  return {
    channel: proxy,
    hold() { gate = new Promise((resolve) => { release = resolve }) },
    release() { release() },
  }
}
