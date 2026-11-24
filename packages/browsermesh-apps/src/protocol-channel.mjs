/**
 * protocol-channel.mjs -- the seam for layered protocols.
 *
 * A layered protocol (a remote-object layer, a file protocol, ...) is written
 * against ONE small interface, the "protocol channel", and neither knows nor
 * cares what carries it:
 *
 *   channel.peer                       verified identity of the other end (a public key,
 *                                      never a field of a message)
 *   channel.maxMessageBytes            payload budget for one message (conservative: the
 *                                      link maximum less framing)
 *   channel.send(obj, { signal })      structured message, bytes (Uint8Array) included
 *   channel.onMessage(cb)              cb(obj, { peer }); returning a promise slows the sender
 *   channel.request(method, params, { signal, onProgress, timeoutMs })  -> Promise<result>
 *   channel.notify(method, params)
 *   channel.onRequest(method, handler)       handler(params, { peer, signal, progress })
 *   channel.onNotification(method, handler)  handler(params, { peer })
 *   channel.onClose(cb)                cb(error)
 *   channel.close()
 *
 * `assertProtocolChannel(x)` checks an object has that shape. The mesh channel
 * link (`mesh-channel.mjs`), the named protocol channels built here, and any
 * hand-written in-memory duplex can all satisfy it.
 *
 * Named protocols. Many protocols share one link. A server registers
 * `serveProtocol(name, handler)`; a client calls `openProtocol(peer, name)`.
 * Opening is a request on the link (`mesh.protocol.open`) that is
 * authorised per protocol: scope `protocol:<name>:open` through
 * `PeerRegistry.checkAccess(peer, 'protocol:<name>', 'open')`, default deny,
 * with the registry's own wildcards (`protocol:*:open`, `protocol:counter:*`).
 * Authorisation is re-checked on every incoming request, notification and
 * message of a served channel, so revoking a scope closes the channel on its
 * next use. `listProtocols(peer)` returns only the protocols (and versions)
 * the caller would be allowed to open.
 *
 * Wire (all on top of a mesh-channel link; nothing new on the envelope):
 *   request  mesh.protocol.open   { name, versions? } -> { name, version }
 *   request  mesh.protocol.list   {} -> [{ name, versions }]
 *   notify   mesh.protocol.close  { name }
 *   protocol methods travel as `<name>/<method>`; raw messages as { $p: name, b }.
 * A peer without protocol support answers `mesh.protocol.*` with -32601 (or
 * does not run the channel at all); nothing here changes the link.
 *
 * Handlers on the opening side: register them with `setup(channel)` (called
 * before the open request is sent) if the server may speak first.
 */
import { ChannelErrorCode, MeshChannelError, createMeshChannelService } from './mesh-channel.mjs'

export const PROTOCOL_OPEN_METHOD = 'mesh.protocol.open'
export const PROTOCOL_LIST_METHOD = 'mesh.protocol.list'
export const PROTOCOL_CLOSE_METHOD = 'mesh.protocol.close'
export const PROTOCOL_FRAMING_RESERVE_BYTES = 512
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** The scope a peer needs to open protocol `name`: `protocol:<name>:open`. */
export function protocolScope(name, action = 'open') {
  validateName(name)
  return `protocol:${name}:${action}`
}

function validateName(name) {
  // No ':' and no '*': a name can never carry a wildcard or another scope part.
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new TypeError('protocol name must match /^[a-z0-9][a-z0-9._-]{0,63}$/')
}

export const PROTOCOL_CHANNEL_METHODS = Object.freeze(['send', 'onMessage', 'request', 'notify', 'onRequest', 'onNotification', 'onClose', 'close'])

/** @throws {TypeError} when `channel` does not have the protocol-channel shape. */
export function assertProtocolChannel(channel) {
  if (!channel || typeof channel !== 'object') throw new TypeError('protocol channel must be an object')
  for (const m of PROTOCOL_CHANNEL_METHODS) {
    if (typeof channel[m] !== 'function') throw new TypeError(`protocol channel is missing ${m}()`)
  }
  if (typeof channel.peer !== 'string' || !channel.peer) throw new TypeError('protocol channel needs a peer identity')
  if (!Number.isSafeInteger(channel.maxMessageBytes) || channel.maxMessageBytes <= 0) throw new TypeError('protocol channel needs maxMessageBytes')
  return channel
}

const err = (code, reason, message) => new MeshChannelError(code, reason, message)

/**
 * Transport-neutral protocol host: works with any link from
 * `createChannelCore` / `createMeshChannelService`.
 *
 * @param {object} [opts]
 * @param {(peer: string, name: string, action: string) => (boolean|{allowed: boolean})} [opts.authorize]
 *   Default deny when absent.
 * @param {Function} [opts.onLog]
 */
export function createProtocolHost({ authorize, onLog } = {}) {
  const log = onLog || (() => {})
  const served = new Map() // name -> { handler, versions }
  const states = new Map() // link -> state
  const allowed = (peer, name, action = 'open') => {
    if (!authorize) return false
    try {
      const r = authorize(peer, name, action)
      return r === true || r?.allowed === true
    } catch { return false }
  }

  function stateOf(link) {
    const st = states.get(link)
    if (!st) throw new Error('createProtocolHost: link is not attached')
    return st
  }

  function makeChannel(st, name, { serving, version }) {
    const link = st.link
    const unsubs = []
    const closeListeners = new Set()
    let closed = false
    const prefix = `${name}/`
    const gate = () => {
      if (closed) throw err(ChannelErrorCode.CANCELLED, 'channel-closed', 'protocol channel closed')
      if (serving && !allowed(link.peer, name)) {
        channel.close('authorization revoked')
        throw err(ChannelErrorCode.UNAUTHORIZED, 'not-authorized', `not authorised for protocol ${name}`)
      }
    }
    const channel = {
      name,
      version,
      serving,
      peer: link.peer,
      get maxMessageBytes() { return Math.max(1, link.maxMessageBytes - PROTOCOL_FRAMING_RESERVE_BYTES) },
      get closed() { return closed },
      send(obj, opts) { try { gate() } catch (e) { return Promise.reject(e) } return link.send({ $p: name, b: obj }, opts) },
      onMessage(cb) {
        if (typeof cb !== 'function') throw new TypeError('onMessage needs a function')
        st.messageListeners.get(name).add(cb)
        const off = () => st.messageListeners.get(name)?.delete(cb)
        unsubs.push(off)
        return off
      },
      request(method, params, opts) {
        try { gate() } catch (e) { return Promise.reject(e) }
        if (typeof method !== 'string' || !method) return Promise.reject(new TypeError('method must be a non-empty string'))
        return link.request(prefix + method, params, opts)
      },
      notify(method, params) {
        try { gate() } catch (e) { return Promise.reject(e) }
        if (typeof method !== 'string' || !method) return Promise.reject(new TypeError('method must be a non-empty string'))
        return link.notify(prefix + method, params)
      },
      onRequest(method, handler) {
        if (typeof method !== 'string' || !method || typeof handler !== 'function') throw new TypeError('onRequest(method, handler)')
        const off = link.onRequest(prefix + method, (params, ctx) => {
          gate()
          return handler(params, { ...ctx, method })
        })
        unsubs.push(off)
        return off
      },
      onNotification(method, handler) {
        if (typeof method !== 'string' || !method || typeof handler !== 'function') throw new TypeError('onNotification(method, handler)')
        const off = link.onNotification(prefix + method, (params, ctx) => {
          try { gate() } catch { return }
          return handler(params, { ...ctx, method })
        })
        unsubs.push(off)
        return off
      },
      onClose(cb) {
        if (typeof cb !== 'function') throw new TypeError('onClose needs a function')
        if (closed) { queueMicrotask(() => cb(null)); return () => {} }
        closeListeners.add(cb)
        return () => closeListeners.delete(cb)
      },
      close(reason, { notifyRemote = true } = {}) {
        if (closed) return
        closed = true
        for (const off of unsubs.splice(0)) { try { off() } catch { /* already gone */ } }
        st.channels.delete(name)
        st.messageListeners.delete(name)
        if (notifyRemote && !link.closed) link.notify(PROTOCOL_CLOSE_METHOD, { name }).catch(() => {})
        const why = reason instanceof Error ? reason : null
        for (const cb of [...closeListeners]) { try { cb(why) } catch (e) { log('protocol:close-listener-threw', { name, error: e?.message }) } }
        closeListeners.clear()
      },
    }
    st.channels.set(name, channel)
    st.messageListeners.set(name, new Set())
    return channel
  }

  /** Attach to a ready link: installs the protocol methods and the raw-message demultiplexer. */
  function attach(link) {
    if (states.has(link)) return () => {}
    const st = { link, channels: new Map(), messageListeners: new Map(), offs: [] }
    states.set(link, st)
    st.offs.push(link.onRequest(PROTOCOL_OPEN_METHOD, (params, ctx) => {
      const name = params?.name
      try { validateName(name) } catch { throw err(ChannelErrorCode.INVALID, 'bad-protocol-name', 'invalid protocol name') }
      // Authorisation first, so an unauthorised caller learns nothing about what is served.
      if (!allowed(ctx.peer, name)) throw err(ChannelErrorCode.UNAUTHORIZED, 'not-authorized', `not authorised for protocol ${name}`)
      const entry = served.get(name)
      if (!entry) throw err(ChannelErrorCode.METHOD_NOT_FOUND, 'unknown-protocol', `protocol ${name} is not served here`)
      const wanted = Array.isArray(params.versions) && params.versions.length ? params.versions : [1]
      const version = entry.versions.filter(v => wanted.includes(v)).sort((a, b) => b - a)[0]
      if (version === undefined) throw err(ChannelErrorCode.UNSUPPORTED, 'unsupported-version', `no common version of ${name}`)
      if (st.channels.has(name)) throw err(ChannelErrorCode.INVALID, 'already-open', `${name} is already open on this link`)
      const channel = makeChannel(st, name, { serving: true, version })
      // The accept handler runs before the response leaves, so it can register handlers first.
      Promise.resolve().then(() => entry.handler(channel, { peer: ctx.peer, version })).catch(e => {
        log('protocol:serve-handler-threw', { name, error: e?.message })
        channel.close(e)
      })
      return { name, version }
    }))
    st.offs.push(link.onRequest(PROTOCOL_LIST_METHOD, (_params, ctx) => {
      const out = []
      for (const [name, entry] of served) if (allowed(ctx.peer, name)) out.push({ name, versions: [...entry.versions] })
      return out
    }))
    st.offs.push(link.onNotification(PROTOCOL_CLOSE_METHOD, params => {
      const ch = typeof params?.name === 'string' ? st.channels.get(params.name) : undefined
      ch?.close(null, { notifyRemote: false })
    }))
    st.offs.push(link.onMessage(async (msg, ctx) => {
      if (!msg || typeof msg.$p !== 'string') return
      const ch = st.channels.get(msg.$p)
      if (!ch) return
      if (ch.serving !== false) {
        // served side: re-check authorisation for this message
        if (!allowed(link.peer, msg.$p)) { ch.close('authorization revoked'); return }
      }
      const listeners = st.messageListeners.get(msg.$p)
      if (!listeners) return
      await Promise.all([...listeners].map(cb => cb(msg.b, { peer: ctx.peer })))
    }))
    st.offs.push(link.onClose(err2 => {
      for (const ch of [...st.channels.values()]) ch.close(err2, { notifyRemote: false })
      states.delete(link)
    }))
    return () => { for (const off of st.offs.splice(0)) off(); states.delete(link) }
  }

  return {
    /** Register a served protocol. `handler(channel, { peer, version })` runs for each accepted open. */
    serveProtocol(name, handler, { versions = [1] } = {}) {
      validateName(name)
      if (typeof handler !== 'function') throw new TypeError('serveProtocol needs a handler')
      if (!Array.isArray(versions) || !versions.length || !versions.every(v => Number.isSafeInteger(v) && v > 0)) throw new TypeError('versions must be positive integers')
      if (served.has(name)) throw new Error(`protocol ${name} is already served`)
      served.set(name, { handler, versions: [...versions] })
      return () => { served.delete(name) }
    },
    attach,
    /**
     * Open protocol `name` on an attached `link`. `setup(channel)` runs before the open request is sent.
     * Rejects with -32003 when not authorised, -32601 when not served, -32000 on no common version.
     */
    async openProtocol(link, name, { versions = [1], setup, signal, timeoutMs } = {}) {
      validateName(name)
      const st = stateOf(link)
      if (st.channels.has(name)) throw err(ChannelErrorCode.INVALID, 'already-open', `protocol ${name} is already open on this link`)
      const channel = makeChannel(st, name, { serving: false, version: undefined })
      try {
        setup?.(channel)
        const res = await link.request(PROTOCOL_OPEN_METHOD, { name, versions }, { signal, timeoutMs })
        channel.version = res?.version
        return channel
      } catch (e) {
        channel.close(e, { notifyRemote: false })
        throw e
      }
    },
    /** Protocols (and versions) `link`'s peer would let this side open. */
    async listProtocols(link, opts) {
      stateOf(link)
      return link.request(PROTOCOL_LIST_METHOD, {}, opts)
    },
    /** Protocols currently open on a link. */
    openProtocols(link) { return [...stateOf(link).channels.keys()] },
    /** Close every open channel of `peer` (or one `name`), e.g. after a revocation. */
    closeProtocols(peer, name) {
      for (const st of states.values()) {
        if (st.link.peer !== peer) continue
        for (const [n, ch] of [...st.channels]) if (name === undefined || n === name) ch.close('closed by the host')
      }
    },
  }
}

/**
 * MeshService descriptor: the channel service plus a protocol host, authorised
 * through the node's `PeerRegistry`. Use it INSTEAD of attaching
 * `createMeshChannelService` as well (both would answer the same envelope type).
 *
 * api: { serveProtocol, openProtocol(peer, name, opts), listProtocols(peer), openProtocols(peer),
 *        closeProtocols(peer, name), channel } where `channel` is the underlying channel service api.
 *
 * Nothing is served and nothing is authorised by default.
 */
export function createMeshProtocolService({ authorize, ...channelOptions } = {}) {
  return {
    name: 'mesh-protocols',
    attach(peerNode, ctx) {
      const registry = ctx.registry
      const host = createProtocolHost({
        authorize: authorize || ((peer, name, action) => registry && typeof registry.checkAccess === 'function'
          ? registry.checkAccess(peer, `protocol:${name}`, action)
          : false),
        onLog: channelOptions.onLog,
      })
      const inner = createMeshChannelService({ ...channelOptions, onLink: link => { host.attach(link); channelOptions.onLink?.(link) } }).attach(peerNode, ctx)
      return {
        api: {
          serveProtocol: host.serveProtocol,
          async openProtocol(peer, name, opts) {
            const link = await inner.api.open(peer, opts?.timeoutMs === undefined ? undefined : { timeoutMs: opts.timeoutMs })
            return host.openProtocol(link, name, opts)
          },
          async listProtocols(peer, opts) {
            const link = await inner.api.open(peer)
            return host.listProtocols(link, opts)
          },
          openProtocols: peer => { const l = inner.api.link(peer); return l ? host.openProtocols(l) : [] },
          closeProtocols: host.closeProtocols,
          channel: inner.api,
        },
        teardown: inner.teardown,
      }
    },
  }
}
