/**
 * realm-channel.mjs -- the dialler's side of a realm exchange as a duck-typed channel (`{ send, onFrame, onClose, close }`),
 * which is what `createRealmProver` from `@johnhenry/browsermesh-realm` is written against. Two adapters:
 *
 *   nodeChannel(node, hostId)         a freshly dialled link: frames are the host's data to this node, sent with `node.sendTo`.
 *                                     Create it BEFORE `connectToPeer`: a realm host sends `realm:hello` the moment the link is
 *                                     restricted, and a frame nobody listens for is lost.
 *   protocolChannel()                 a `realm` protocol channel opened over an existing link (renewal): hand the protocol channel
 *                                     in with `attach(channel)` once `openProtocol` has returned it.
 *
 * Frames that arrive before the prover subscribes are buffered. Internal: not exported from the package.
 */

/** Failures the dialler's own timer reports, where the host is not at fault and the link is left as it is. */
const KEEP_LINK = new Set(['peer-does-not-speak-realms', 'timeout'])

/**
 * @param {object} node a PeerNode
 * @param {string} hostId the pod id of the host
 * @returns {{ send: Function, onFrame: Function, onClose: Function, close: Function, dispose: (reason?: string) => void }}
 */
export function nodeChannel(node, hostId) {
  const pending = []
  let onFrame = null
  let onClose = null
  let disposed = false
  const offData = node.onIncomingData((from, data) => {
    if (from !== hostId) return
    if (onFrame) onFrame(data)
    else pending.push(data)
  })
  const onTransportClose = (e) => { if (e?.pubKey === hostId) onClose?.('peer-closed') }
  node.on('peer:transport-close', onTransportClose)
  return {
    send: (frame) => node.sendTo(hostId, frame),
    onFrame: (cb) => { onFrame = cb; while (pending.length) cb(pending.shift()) },
    onClose: (cb) => { onClose = cb },
    /** The prover calls this on a failure: a host that refused has closed, one that spoke nonsense is dropped. */
    close: (reason) => {
      if (KEEP_LINK.has(reason)) return
      try { node.disconnectPeer(hostId) } catch { /* the node may be stopping, or the peer already gone */ }
    },
    /** Stop listening (after the prover settled, or at shutdown: a pending prover then ends as `peer-closed`). */
    dispose(reason) {
      if (disposed) return
      disposed = true
      offData()
      node.off?.('peer:transport-close', onTransportClose)
      if (reason) onClose?.(reason)
    },
  }
}

/**
 * A prover channel over a `realm` protocol channel. Frames the host sent before the channel was handed in (it may speak first)
 * are not lost: `capture(channel)` is the `setup` of `openProtocol`, run before the open request is sent.
 */
export function protocolChannel() {
  const pending = []
  let onFrame = null
  let onClose = null
  let channel = null
  return {
    /** `openProtocol(peer, 'realm', { setup: ch.capture })` */
    capture(ch) {
      channel = ch
      ch.onMessage((frame) => { if (onFrame) return onFrame(frame); pending.push(frame); return undefined })
      ch.onClose(() => { onClose?.('peer-closed') })
    },
    send: (frame) => channel.send(frame),
    onFrame: (cb) => { onFrame = cb; while (pending.length) cb(pending.shift()) },
    onClose: (cb) => { onClose = cb },
    close: (reason) => { try { channel?.close(typeof reason === 'string' ? reason : undefined) } catch { /* already closed */ } },
  }
}
