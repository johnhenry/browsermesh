/**
 * A tiny layered protocol -- a remote counter object with get / call /
 * subscribe -- written against ONLY the protocol-channel interface
 * (request, notify, onRequest, onNotification, onClose, peer). It imports
 * nothing from the mesh. It exists to prove the seam, not as a product feature.
 */

/** A local object to expose. */
export function makeCounter() {
  const listeners = new Set()
  const counter = {
    value: 0,
    bytes: new Uint8Array([1, 2, 3]),
    inc(n = 1) { counter.value += n; for (const cb of [...listeners]) cb('value', counter.value); return counter.value },
    reset() { counter.value = 0; for (const cb of [...listeners]) cb('value', 0) },
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb) },
  }
  return counter
}

const READABLE = new Set(['value', 'bytes'])
const CALLABLE = new Set(['inc', 'reset'])

/** Serve `counter` on one protocol channel. Records who asked (the channel's verified peer). */
export function serveCounter(channel, counter, { seen } = {}) {
  const subs = new Map() // id -> { path, off }
  let nextId = 1
  channel.onRequest('get', ({ path }, ctx) => {
    seen?.push(['get', ctx.peer, channel.peer])
    if (!READABLE.has(path)) throw new Error(`no such property: ${path}`)
    return counter[path]
  })
  channel.onRequest('call', ({ path, args = [] }, ctx) => {
    seen?.push(['call', ctx.peer, channel.peer])
    if (!CALLABLE.has(path)) throw new Error(`no such method: ${path}`)
    return counter[path](...args)
  })
  channel.onRequest('subscribe', ({ path }) => {
    if (!READABLE.has(path)) throw new Error(`no such property: ${path}`)
    const id = nextId++
    const off = counter.onChange((changed, value) => {
      if (changed === path) channel.notify('changed', { id, path, value }).catch(() => {})
    })
    subs.set(id, { path, off })
    return { id }
  })
  channel.onRequest('unsubscribe', ({ id }) => {
    const sub = subs.get(id)
    sub?.off()
    return subs.delete(id)
  })
  channel.onClose(() => { for (const { off } of subs.values()) off(); subs.clear() })
}

/** Client side of the same protocol. */
export function counterClient(channel) {
  const handlers = new Map()
  channel.onNotification('changed', ({ id, value }) => handlers.get(id)?.(value))
  return {
    get: path => channel.request('get', { path }),
    call: (path, ...args) => channel.request('call', { path, args }),
    async subscribe(path, cb) {
      const { id } = await channel.request('subscribe', { path })
      handlers.set(id, cb)
      return async () => { handlers.delete(id); await channel.request('unsubscribe', { id }) }
    },
  }
}

/** The scenario every transport must pass. `settle` drains pending deliveries. */
export async function runCounterScenario({ client, counter, settle, assert, seen, clientPeer }) {
  const c = counterClient(client)
  assert.equal(await c.get('value'), 0)
  assert.equal(await c.call('inc', 5), 5)
  assert.equal(await c.get('value'), 5)
  const bytes = await c.get('bytes')
  assert.ok(bytes instanceof Uint8Array)
  assert.deepEqual(bytes, new Uint8Array([1, 2, 3]))
  const got = []
  const unsubscribe = await c.subscribe('value', v => got.push(v))
  counter.inc(1); counter.inc(1)
  await settle()
  assert.deepEqual(got, [6, 7])
  await unsubscribe()
  counter.inc(1)
  await settle()
  assert.deepEqual(got, [6, 7])
  await assert.rejects(c.get('secret'), /no such property/)
  await assert.rejects(c.call('constructor'), /no such method/)
  // The server's handlers were told who asked by the channel, not by the message.
  for (const [, ctxPeer, channelPeer] of seen) { assert.equal(ctxPeer, clientPeer); assert.equal(channelPeer, clientPeer) }
  assert.ok(seen.length >= 3)
}

/**
 * A hand-written in-memory duplex that satisfies the protocol-channel interface
 * without any mesh code at all: the proof that the interface is transport-neutral.
 */
export function memoryChannelPair(peerA = 'mem-a', peerB = 'mem-b') {
  const make = (peer) => {
    const st = { requests: new Map(), notes: new Map(), messages: new Set(), closers: new Set(), closed: false, other: null }
    st.channel = {
      peer,
      maxMessageBytes: 1 << 20,
      send: async obj => { for (const cb of [...st.other.messages]) await cb(structuredClone(obj), { peer }) },
      onMessage: cb => { st.messages.add(cb); return () => st.messages.delete(cb) },
      request: async (method, params, { signal } = {}) => {
        if (st.closed) throw new Error('closed')
        const handler = st.other.requests.get(method)
        if (!handler) throw new Error(`no handler for ${method}`)
        const controller = new AbortController()
        signal?.addEventListener('abort', () => controller.abort(), { once: true })
        await Promise.resolve()
        return structuredClone(await handler(structuredClone(params), { peer, signal: controller.signal, progress() {} }))
      },
      notify: async (method, params) => {
        await Promise.resolve()
        for (const h of st.other.notes.get(method) || []) h(structuredClone(params), { peer })
      },
      onRequest: (method, h) => { st.requests.set(method, h); return () => st.requests.delete(method) },
      onNotification: (method, h) => {
        if (!st.notes.has(method)) st.notes.set(method, new Set())
        st.notes.get(method).add(h)
        return () => st.notes.get(method)?.delete(h)
      },
      onClose: cb => { st.closers.add(cb); return () => st.closers.delete(cb) },
      close: () => { st.closed = true; for (const cb of st.closers) cb(null) },
    }
    return st
  }
  const a = make(peerA), b = make(peerB)
  a.other = b; b.other = a
  // Each end reports the OTHER end as its peer, like a real link.
  a.channel.peer = peerB; b.channel.peer = peerA
  return { a: a.channel, b: b.channel }
}
