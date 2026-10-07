/**
 * peer-node-transport.mjs -- the host half of `wireTransport(broadcastFn,
 * subscribeFn)`.
 *
 * `PaymentRouter`, `ConsensusManager` (both in this package),
 * `MigrationEngine` (`@johnhenry/browsermesh-sync`) and `GroupKeyManager`
 * (`@johnhenry/browsermesh-core`) each expose
 * `wireTransport(broadcastFn, subscribeFn)` and leave the host to supply the
 * one-to-all send and the typed subscription. This builds both from a
 * `PeerNode`, so wiring all four is one call each:
 *
 *   const { broadcastFn, subscribeFn } = createPeerNodeTransport(peerNode)
 *   paymentRouter.wireTransport(broadcastFn, subscribeFn)
 *   consensus.wireTransport(broadcastFn, subscribeFn)
 *   migration.wireTransport(broadcastFn, subscribeFn)
 *   groupKeys.wireTransport(broadcastFn, subscribeFn)
 *
 * Wire shape: `peerNode.broadcast({ type: <wireType>, payload, from })`,
 * where `<wireType>` is the module's numeric message constant
 * (`PAYMENT_OPEN`, `CONSENSUS_VOTE`, ...). `subscribeFn(wireType, handler)`
 * calls `handler(payload, fromPodId)` for matching inbound envelopes.
 * `fromPodId` is the pubKey of the session the message arrived on -- the
 * transport-authenticated sender -- never the envelope's own `from` field,
 * which a remote peer could set to anything.
 *
 * Inbound envelopes are accepted as parsed objects or as JSON text, like
 * `ctx.onIncomingData()`.
 *
 * Browser-safe: no imports beyond a sibling internal helper.
 */

import { decodeWireData } from './internal/wire-envelope.mjs'

/**
 * @param {import('./peer-node.mjs').PeerNode} peerNode
 * @param {object} [opts]
 * @param {string} [opts.podId] - Value for the envelope's informational
 *   `from` field. Defaults to `peerNode.podId`.
 * @param {'control'|'bulk'} [opts.channel] - Data channel for outbound
 *   broadcasts. Defaults to the control lane.
 * @param {(event: string, data: object) => void} [opts.onLog]
 * @returns {{
 *   broadcastFn: (wireType: number, payload: object) => Promise<{sent: string[], failed: {pubKey: string, error: string}[]}>,
 *   subscribeFn: (wireType: number, handler: (payload: object, fromPodId: string) => void) => (() => void),
 *   dispose: () => void,
 * }}
 *   `broadcastFn` never rejects (a stopped node or a dead peer is reported
 *   through `onLog`, not thrown at a fire-and-forget caller). `subscribeFn`
 *   returns an unsubscribe function; `dispose()` drops every subscription.
 */
export function createPeerNodeTransport(peerNode, { podId, channel, onLog } = {}) {
  if (!peerNode || typeof peerNode.broadcast !== 'function' || typeof peerNode.onIncomingData !== 'function') {
    throw new Error('createPeerNodeTransport: peerNode with broadcast() and onIncomingData() is required')
  }
  const log = typeof onLog === 'function' ? onLog : () => {}

  /** @type {Map<*, Set<Function>>} */
  const handlers = new Map()
  let unsubscribeIncoming = null

  function ensureListening() {
    if (unsubscribeIncoming) return
    unsubscribeIncoming = peerNode.onIncomingData((fromPubKey, rawData) => {
      const env = decodeWireData(rawData)
      if (!env || typeof env !== 'object' || !('payload' in env)) return
      const set = handlers.get(env.type)
      if (!set) return
      for (const handler of [...set]) {
        try {
          const result = handler(env.payload, fromPubKey)
          if (result && typeof result.catch === 'function') {
            result.catch((err) => log('peer-node-transport:handler-error', { type: env.type, error: err?.message || String(err) }))
          }
        } catch (err) {
          log('peer-node-transport:handler-error', { type: env.type, error: err?.message || String(err) })
        }
      }
    })
  }

  function broadcastFn(wireType, payload) {
    const localPodId = podId ?? peerNode.podId
    return peerNode
      .broadcast({ type: wireType, payload, from: localPodId }, channel === undefined ? undefined : { channel })
      .then((result) => {
        for (const f of result.failed) log('peer-node-transport:broadcast-send-failed', { type: wireType, to: f.pubKey, error: f.error })
        return result
      })
      .catch((err) => {
        log('peer-node-transport:broadcast-failed', { type: wireType, error: err?.message || String(err) })
        return { sent: [], failed: [] }
      })
  }

  function subscribeFn(wireType, handler) {
    if (typeof handler !== 'function') return () => {}
    let set = handlers.get(wireType)
    if (!set) {
      set = new Set()
      handlers.set(wireType, set)
    }
    set.add(handler)
    ensureListening()
    return () => { set.delete(handler) }
  }

  function dispose() {
    handlers.clear()
    if (unsubscribeIncoming) unsubscribeIncoming()
    unsubscribeIncoming = null
  }

  return { broadcastFn, subscribeFn, dispose }
}
