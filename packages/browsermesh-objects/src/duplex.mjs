/**
 * duplex.mjs -- a mesh protocol channel as the object layer's peer, with the
 * backpressure the layer expects.
 *
 * wsh's `createDuplexPeer({ send })` takes a synchronous `send` and its
 * `notify` returns nothing. The layer's event and callback pump awaits what
 * `notify` returns ("the write waits for the channel's credit") and keeps at
 * most `maxQueuedEvents` waiting, dropping and counting the rest. A bare
 * duplex peer returns nothing, so the pump would never wait: every event
 * would go straight into the mesh channel's send queue, which holds a message
 * until credit is granted and is not bounded by anything of wsh's. This
 * module makes `notify` return the channel's own send promise, so a reader
 * that stops reading (no credit) makes the pump wait, its bounded queue fill,
 * and events be dropped and counted by the layer.
 *
 * Responses, progress and cancel frames are not events: each answers a
 * request the far side made. They are sent at once, but the number of sends
 * not yet accepted by the channel is bounded (`maxPendingSends`): a peer that
 * keeps asking and never reads is cut off (the objects channel is closed,
 * `stats().closedSlow` counts it) instead of growing this side's memory.
 */
import { createDuplexPeer } from '@johnhenry/wsh/objects'

/** Sends the channel has not accepted yet, at most, before the peer is cut off. */
export const DEFAULT_MAX_PENDING_SENDS = 256

/**
 * @param {object} channel - a protocol channel (`send`, `onMessage`, `onClose`, `maxMessageBytes`, `close`)
 * @param {object} [opts]
 * @param {number} [opts.maxPendingSends=256]
 * @returns the layer's peer (`request`, `notify`, `onRequest`, `onNotification`, `onClose`, `maxMessageBytes`, `close`, `closed`) plus `stats()`
 */
export function duplexOverChannel(channel, { maxPendingSends = DEFAULT_MAX_PENDING_SENDS } = {}) {
  if (!Number.isSafeInteger(maxPendingSends) || maxPendingSends < 1) throw new TypeError('maxPendingSends must be a positive integer')
  const stats = { pendingSends: 0, sendFailures: 0, closedSlow: 0 }
  let lastSend // the channel's promise for the message `send` was just given

  const duplex = createDuplexPeer({
    maxMessageBytes: channel.maxMessageBytes,
    send(message) {
      lastSend = undefined
      if (stats.pendingSends >= maxPendingSends) {
        stats.closedSlow += 1
        duplex.close('the far side is not reading')
        try { channel.close('the far side is not reading') } catch { /* already closed */ }
        return
      }
      stats.pendingSends += 1
      lastSend = channel.send(message).then(
        () => { stats.pendingSends -= 1 },
        () => { stats.pendingSends -= 1; stats.sendFailures += 1; duplex.close('send failed') },
      )
    },
  })
  channel.onMessage((message) => { duplex.receive(message) })
  channel.onClose(() => duplex.close('channel closed'))

  const peer = {
    get maxMessageBytes() { return duplex.maxMessageBytes },
    get closed() { return duplex.closed },
    get onClose() { return duplex.onClose },
    set onClose(fn) { duplex.onClose = fn },
    onRequest: (method, handler) => duplex.onRequest(method, handler),
    onNotification: (method, handler) => duplex.onNotification(method, handler),
    request: (method, params, options) => duplex.request(method, params, options),
    /** Resolves when the channel has taken the message (its credit allowed it); the layer's pump waits on it. */
    notify(method, params) {
      lastSend = undefined
      duplex.notify(method, params)
      const sent = lastSend
      lastSend = undefined
      return sent
    },
    close(reason) {
      duplex.close(reason)
      try { channel.close(reason) } catch { /* already closed */ }
    },
    stats: () => ({ ...stats }),
  }
  return peer
}
