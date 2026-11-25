/**
 * serve.mjs -- serve wsh's remote-object layer to mesh peers.
 *
 *   const objects = exposeObjectsOnMesh(service, {
 *     roots: { app },                       // the named roots: all that is reachable
 *     allow: { get: ['app.title'], call: ['app.counter.inc'], on: ['app.bus@ready'] },
 *   })
 *   registry.grantCapabilities(peerPodId, ['protocol:objects:open', 'objects:app:get'])
 *
 * Two authorisations apply to every operation, and both must say yes: wsh's
 * allow-lists (what the HOST offers, by path) and then the registry grant of
 * the channel's verified peer (what THIS PEER may do on that root), each
 * operation by its own action (see actions.mjs). Default deny at both.
 *
 * Revocation: a request is judged when it arrives, so a revoked or expired
 * grant refuses the very next one. What a peer holds OPEN is judged again too:
 * an event subscription needs `on` and a callback needs `call` (it is an
 * argument of a call) at every delivery and whenever `watch` reports an access
 * change for that peer; a peer that has lost one of them has the objects
 * channel closed. Losing the protocol scope itself closes the channel through
 * the protocol host, as for any protocol.
 */
import { createObjectsServer } from '@johnhenry/wsh/objects'
import { OBJECT_ACTIONS, actionFor } from './actions.mjs'
import { whoFor, podIdOf } from './who.mjs'
import { duplexOverChannel } from './duplex.mjs'

const defaultRandom = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))
const defaultTimers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) }

/**
 * @param {object|Function} target - a mesh service (`attachService(node, undefined, createMeshProtocolService())`, or its `.api`):
 *   the objects are served with its `serveProtocol`, and its `rootAuthorizer` is the default authorizer.
 *   Or a channel factory `(accept) => stop`: called once with `accept(channel)`, to register on any protocol host
 *   (`(accept) => host.serveProtocol('objects', accept)`); then `authorizer` is required.
 * @param {object} opts
 * @param {Record<string, object>} opts.roots - the named roots
 * @param {object} [opts.allow] - wsh's allow-lists by operation (`get`, `call`, `set`, `on`); nothing is allowed by default
 * @param {Record<string, object>} [opts.handles] - roots that opt in to handles (wsh's option, unchanged)
 * @param {Record<string, string[]>} [opts.eventFields] - event fields a subscriber may ask for, by event type (wsh's option)
 * @param {object} [opts.limits] - wsh's bounds (`maxSubscriptions`, `maxQueuedEvents`, `maxHandles`, ...)
 * @param {string} [opts.protocol='objects'] - the protocol name; also the prefix of the scopes (`<protocol>:<root>:<action>`)
 * @param {{ can: Function, scope?: Function }} [opts.authorizer] - a `createRootAuthorizer` result; default: the service's own, backed by its registry
 * @param {(listener: (event: { pubKey: string }) => void) => (() => void)} [opts.watch] - `registry.onAccessChange.bind(registry)`:
 *   with it a revoked or expired grant is noticed at once, not at the next delivery
 * @param {number[]} [opts.versions] - protocol versions to serve (default [1])
 * @param {number} [opts.maxPendingSends] - see duplex.mjs
 * @returns {{ protocol: string, authorizer: object, stop(): void, sessions(): number, stats(): object }}
 */
export function exposeObjectsOnMesh(target, opts = {}) {
  const {
    roots, allow = {}, handles, eventFields, limits, protocol = 'objects', watch, versions, maxPendingSends,
    random = defaultRandom, timers = defaultTimers,
  } = opts
  if (!roots || typeof roots !== 'object' || !Object.keys(roots).length) throw new TypeError('exposeObjectsOnMesh: roots must name at least one root')
  const api = target && typeof target === 'object' ? (target.api ?? target) : null
  if (typeof target !== 'function' && typeof api?.serveProtocol !== 'function') {
    throw new TypeError('exposeObjectsOnMesh: the first argument is a mesh service (with serveProtocol) or a channel factory function')
  }
  const authorizer = opts.authorizer ?? (typeof api?.rootAuthorizer === 'function' ? api.rootAuthorizer(protocol, { actions: [...OBJECT_ACTIONS] }) : undefined)
  if (!authorizer || typeof authorizer.can !== 'function') throw new TypeError('exposeObjectsOnMesh: an authorizer is required (createRootAuthorizer), nothing is served without one')
  if (watch !== undefined && typeof watch !== 'function') throw new TypeError('exposeObjectsOnMesh: watch must be a function')
  // A root name that could carry scope syntax is refused here, not at the first request.
  for (const root of Object.keys(roots)) authorizer.scope?.(root, 'get')

  const can = (podId, root, action) => {
    if (!podId || !action) return false
    try { return authorizer.can(podId, root, action) === true } catch { return false }
  }

  const server = createObjectsServer({
    roots,
    mode: 'values',
    allow,
    handles,
    eventFields,
    limits,
    random,
    timers,
    // Asked for every operation the allow-lists let through: the registry grant of the verified peer, for this operation's own action.
    authorize: (who, op) => can(podIdOf(who), op.root, actionFor(op)),
  })

  const sessions = new Set()
  const counters = { sessions: 0, revoked: 0, droppedNotifications: 0, closedSlow: 0, sendFailures: 0 }

  function accept(channel) {
    const podId = channel.peer
    const peer = duplexOverChannel(channel, { maxPendingSends })
    const subs = new Map() // subscription id -> root
    const callbacks = new Map() // callback id -> root
    const session = { channel, peer }
    sessions.add(session)
    counters.sessions += 1

    const revoke = () => {
      counters.revoked += 1
      peer.close('authorization revoked')
    }
    /** An open subscription needs `on` on its root, an open callback `call`: asked again, now. */
    const stillHeld = () => {
      for (const root of subs.values()) if (!can(podId, root, 'on')) return false
      for (const root of callbacks.values()) if (!can(podId, root, 'call')) return false
      return true
    }
    /** What the registry lets this peer do on a root, as the layer asks it: `walk` (reading on the way to something) needs some action. */
    const permits = (root, action) => {
      if (action === 'walk') return OBJECT_ACTIONS.some((a) => can(podId, root, a))
      return OBJECT_ACTIONS.includes(action) && can(podId, root, action)
    }
    const offWatch = watch ? watch((event) => { if (event?.pubKey === podId && !stillHeld()) revoke() }) : null

    const guarded = {
      get maxMessageBytes() { return peer.maxMessageBytes },
      get onClose() { return peer.onClose },
      set onClose(fn) { peer.onClose = fn },
      onRequest(method, handler) {
        peer.onRequest(method, async (params, ctx) => {
          const wired = trackOpen(method, params)
          // The layer asks `permit(root, action)` for what it is about to do; a subscription through a handle names no root in
          // its request, so the root it was judged for is taken from that question (and forgotten if the request fails).
          let throughHandle = null
          const permit = (root, action) => {
            const ok = permits(root, action)
            if (ok && action === 'on' && method === 'subscribe' && params?.handle !== undefined && Number.isSafeInteger(params.id) && typeof root === 'string') {
              subs.set(params.id, root)
              throughHandle = params.id
            }
            return ok
          }
          try {
            const result = await handler(params, { ...ctx, permit })
            // A peer is told of the roots it can use on some action, no others.
            return method === 'roots' && Array.isArray(result?.roots)
              ? { ...result, roots: result.roots.filter((root) => OBJECT_ACTIONS.some((action) => can(podId, root, action))) }
              : result
          } catch (e) { wired?.undo(); if (throughHandle !== null) subs.delete(throughHandle); throw e }
        })
      },
      /** Events and callbacks leave through the channel's credit, and only while the grant that allowed them still holds. */
      notify(method, params) {
        if (method === 'event' || method === 'callback') {
          const owner = method === 'event' ? subs : callbacks
          const root = owner.get(params?.id)
          if (root === undefined) { counters.droppedNotifications += 1; return undefined }
          if (!can(podId, root, method === 'event' ? 'on' : 'call')) { revoke(); return undefined }
        }
        return peer.notify(method, params)
      },
    }

    /** Remember which root an open subscription or callback belongs to (the layer's `subscribe` and `resolve` requests name it). */
    function trackOpen(method, params) {
      if (method === 'subscribe' && Number.isSafeInteger(params?.id) && typeof params.root === 'string') {
        subs.set(params.id, params.root)
        return { undo: () => subs.delete(params.id) }
      }
      if (method === 'unsubscribe') { subs.delete(params?.id); return null }
      if (method === 'releaseCallback') { callbacks.delete(params?.id); return null }
      if (method === 'resolve' && typeof params?.root === 'string' && Array.isArray(params.ops)) {
        const added = []
        for (const op of params.ops) {
          for (const entry of Array.isArray(op?.callbacks) ? op.callbacks : []) {
            const id = Array.isArray(entry) ? entry[1] : undefined
            if (Number.isSafeInteger(id) && !callbacks.has(id)) { callbacks.set(id, params.root); added.push(id) }
          }
        }
        return added.length ? { undo: () => { for (const id of added) callbacks.delete(id) } } : null
      }
      return null
    }

    server.attach(guarded, { who: whoFor(podId) })
    const prior = peer.onClose
    peer.onClose = (reason) => {
      sessions.delete(session)
      offWatch?.()
      const s = peer.stats()
      counters.closedSlow += s.closedSlow
      counters.sendFailures += s.sendFailures
      subs.clear()
      callbacks.clear()
      try { prior?.(reason) } catch { /* the layer's own cleanup must not stop ours */ }
    }
  }

  const stopServing = typeof target === 'function' ? target(accept) : api.serveProtocol(protocol, accept, versions ? { versions } : undefined)

  return {
    protocol,
    authorizer,
    /** Stop serving and end every session. */
    stop() {
      if (typeof stopServing === 'function') stopServing()
      for (const { peer } of [...sessions]) peer.close('objects host stopped')
    },
    sessions: () => sessions.size,
    stats: () => ({ ...counters, openSessions: sessions.size, pendingSends: [...sessions].reduce((n, s) => n + s.peer.stats().pendingSends, 0) }),
  }
}
