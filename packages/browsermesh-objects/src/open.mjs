/**
 * open.mjs -- consume a peer's objects: the roots as lazy references
 * (`await roots.app.counter.value`), with wsh's `get`, `set`, `call`, `on`,
 * `snapshot`, `use` and `release` working on them unchanged.
 */
import { createObjectsClient } from '@johnhenry/wsh/objects'
import { assertProtocolChannel } from '@johnhenry/browsermesh-apps/protocol-channel'
import { ChannelErrorCode } from '@johnhenry/browsermesh-apps/mesh-channel'
import { duplexOverChannel } from './duplex.mjs'

/** A peer that does not serve objects at all, or serves a version this side cannot speak. `reason` names which. */
export class ObjectsOnMeshError extends Error {
  constructor(reason, message, cause) {
    super(message, cause ? { cause } : undefined)
    this.name = 'ObjectsOnMeshError'
    this.reason = reason
    this.code = cause?.code
  }
}

function mapOpenError(error, protocol) {
  if (error?.code === ChannelErrorCode.METHOD_NOT_FOUND) {
    return new ObjectsOnMeshError('not-served', `the peer does not serve the "${protocol}" protocol (an older peer, or objects are not exposed there)`, error)
  }
  if (error?.code === ChannelErrorCode.UNSUPPORTED) {
    return new ObjectsOnMeshError('unsupported', `the peer cannot speak this version of the "${protocol}" protocol`, error)
  }
  return error
}

/**
 * @param {object} target - an open protocol channel, or a mesh service (`attachService(..., createMeshProtocolService())` or its `.api`)
 * @param {string|object} [peer] - the peer's pod id when `target` is a service (the channel is opened here); options may be given here instead for a channel
 * @param {object} [opts]
 * @param {string} [opts.protocol='objects'] - used when opening through a service
 * @param {number} [opts.timeoutMs] - for opening, and for the layer's requests
 * @param {Function} [opts.onCallbackError] - a callback of ours threw (wsh's option)
 * @param {Function} [opts.onCallbackDropped] - the host dropped calls of a callback (wsh's option)
 * @param {number} [opts.maxPendingSends] - see duplex.mjs
 * @returns {Promise<{ roots: object, channel: object, peer: object, close(): void }>}
 *   `roots` are the host's roots as lazy references; `peer.stats()` counts sends, failures and cut-offs.
 */
export async function openObjectsOnMesh(target, peer, opts) {
  if (peer !== null && typeof peer === 'object') { opts = peer; peer = undefined }
  const { protocol = 'objects', timeoutMs, onCallbackError, onCallbackDropped, maxPendingSends } = opts ?? {}
  let channel
  let duplex
  const attachDuplex = (ch) => { duplex = duplexOverChannel(ch, { maxPendingSends }) }
  const api = target && typeof target === 'object' ? (target.api ?? target) : null
  if (typeof api?.openProtocol === 'function') {
    if (typeof peer !== 'string' || !peer) throw new TypeError('openObjectsOnMesh: the peer to open the protocol on is required with a service')
    try {
      // The duplex is built in `setup`, before the open request leaves, so nothing arrives before it listens.
      channel = await api.openProtocol(peer, protocol, { ...(timeoutMs === undefined ? {} : { timeoutMs }), setup: attachDuplex })
    } catch (e) { throw mapOpenError(e, protocol) }
  } else {
    assertProtocolChannel(target)
    channel = target
    attachDuplex(channel)
  }
  try {
    const roots = await createObjectsClient(duplex, { ...(timeoutMs === undefined ? {} : { timeoutMs }), onCallbackError, onCallbackDropped })
    return { roots, channel, peer: duplex, close: () => duplex.close('closed by the opener') }
  } catch (e) {
    duplex.close('could not open the objects')
    throw e
  }
}
