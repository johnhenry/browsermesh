/**
 * Attachable, bounded request/response RPC over a MeshService context.
 * The caller identity comes from the transport. Each service handler owns its
 * resource authorization; this transport does not grant access to any resource.
 *
 * Structured bodies keep their existing JSON semantics. Top-level binary
 * bodies use an explicit bodyEncoding field so they survive JSON transports.
 * Cancellation is advisory: aborting does not undo side effects already made.
 */
import { encodeBody, decodeBody } from './internal/rpc-body.mjs'

const DEFAULT_ENVELOPE_TYPE = 'mesh-rpc'
const DEFAULT_REQUEST_TIMEOUT_MS = 10000
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024
const abortError = reason => reason?.name === 'AbortError' ? reason : new DOMException(reason?.message || 'RPC request aborted', 'AbortError')
const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 512

export function createMeshRpcService({
  onRequest,
  envelopeType = DEFAULT_ENVELOPE_TYPE,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  maxInflight = 64,
  maxIncoming = 64,
  maxIncomingPerPeer = 8,
  onLog,
} = {}) {
  if (onRequest !== undefined && typeof onRequest !== 'function') throw new TypeError('createMeshRpcService: onRequest must be a function if provided')
  for (const [name, value] of Object.entries({ requestTimeoutMs, maxBodyBytes, maxInflight, maxIncoming, maxIncomingPerPeer })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`createMeshRpcService: ${name} must be a positive integer`)
  }
  const log = onLog || (() => {})
  return {
    name: 'mesh-rpc',
    attach(peerNode, ctx) {
      let seq = 0, closed = false
      const pending = new Map()
      const incoming = new Map()
      const incomingCounts = new Map()
      const keyFor = (peer, id) => JSON.stringify([peer, id])
      const send = (peer, message) => ctx.sendTo(peer, envelopeType, message)
      function settle(id, error, result) {
        const p = pending.get(id)
        if (!p) return
        pending.delete(id)
        clearTimeout(p.timer)
        p.signal?.removeEventListener('abort', p.onAbort)
        if (error) p.reject(error)
        else p.resolve(result)
      }
      function cancel(id, error) {
        const p = pending.get(id)
        if (!p) return
        settle(id, error)
        // Older responders ignore this new kind. The local promise still ends.
        Promise.resolve().then(() => send(p.target, { kind: 'rpc-cancel', requestId: id })).catch(() => {})
      }
      async function handleRequest(from, msg) {
        if (closed || !validId(msg.requestId)) return
        const key = keyFor(from, msg.requestId)
        if (incoming.has(key)) return
        if (incoming.size >= maxIncoming || (incomingCounts.get(from) || 0) >= maxIncomingPerPeer) {
          await send(from, { kind: 'rpc-response', requestId: msg.requestId, status: 429, body: { error: 'too many RPC requests' } })
          return
        }
        let body
        try { body = decodeBody(msg, maxBodyBytes) }
        catch {
          await send(from, { kind: 'rpc-response', requestId: msg.requestId, status: 400, body: { error: 'invalid or oversized RPC body' } })
          return
        }
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(new DOMException('RPC handler deadline exceeded', 'TimeoutError')), requestTimeoutMs)
        timer.unref?.()
        incoming.set(key, { controller, timer })
        incomingCounts.set(from, (incomingCounts.get(from) || 0) + 1)
        try {
          let result
          if (!onRequest) result = { status: 501, body: { error: 'no RPC handler registered' } }
          else {
            try {
              const handled = await onRequest({ fromPubKey: from, method: msg.method, path: msg.path, headers: msg.headers, body, signal: controller.signal })
              result = handled && typeof handled === 'object' ? handled : {}
            } catch (error) {
              if (controller.signal.aborted) return
              log('mesh-rpc:handler-threw', { from, requestId: msg.requestId, error: error?.message || String(error) })
              ctx.emit('mesh-rpc:handler-error', { from, method: msg.method, path: msg.path, error: error?.message || String(error) })
              result = { status: 500, body: { error: error?.message || String(error) } }
            }
          }
          if (closed || controller.signal.aborted) return
          let status = Number.isInteger(result.status) ? result.status : 200
          let encoded
          try { encoded = encodeBody(result.body, maxBodyBytes) }
          catch { encoded = { body: { error: 'invalid or oversized RPC response' } }; status = 500 }
          await send(from, { kind: 'rpc-response', requestId: msg.requestId, status, headers: result.headers || {}, ...encoded })
          ctx.emit('mesh-rpc:request-served', { from, method: msg.method, path: msg.path, status })
        } finally {
          clearTimeout(timer)
          incoming.delete(key)
          const count = (incomingCounts.get(from) || 1) - 1
          if (count) incomingCounts.set(from, count)
          else incomingCounts.delete(from)
        }
      }
      const unsubscribe = ctx.onIncomingData(envelopeType, (from, msg) => {
        if (closed || !msg || !validId(msg.requestId)) return
        if (msg.kind === 'rpc-request') {
          handleRequest(from, msg).catch(error => log('mesh-rpc:response-send-failed', { to: from, error: error?.message || String(error) }))
        } else if (msg.kind === 'rpc-cancel') {
          const active = incoming.get(keyFor(from, msg.requestId))
          if (active) { clearTimeout(active.timer); active.controller.abort(abortError()) }
        } else if (msg.kind === 'rpc-response') {
          const p = pending.get(msg.requestId)
          // A request ID is correlation data, never proof of the responder.
          if (!p || p.target !== from) return
          try { settle(msg.requestId, null, { status: msg.status, headers: msg.headers || {}, body: decodeBody(msg, maxBodyBytes) }) }
          catch (error) { settle(msg.requestId, error) }
        }
      })
      function request(target, { method = 'GET', path = '/', headers = {}, body } = {}, { signal, timeoutMs = requestTimeoutMs } = {}) {
        if (closed) return Promise.reject(new Error('mesh-rpc: service torn down'))
        if (typeof target !== 'string' || !target || target.length > 512) return Promise.reject(new TypeError('mesh-rpc: target must identify one peer'))
        if (signal?.aborted) return Promise.reject(abortError(signal.reason))
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return Promise.reject(new TypeError('mesh-rpc: timeoutMs must be a positive integer'))
        if (pending.size >= maxInflight) return Promise.reject(new Error('mesh-rpc: too many requests in flight'))
        let encoded
        try { encoded = encodeBody(body, maxBodyBytes) } catch (error) { return Promise.reject(error) }
        const requestId = `${peerNode?.podId || 'local'}:${Date.now()}:${++seq}`
        return new Promise((resolve, reject) => {
          const onAbort = () => cancel(requestId, abortError(signal.reason))
          const timer = setTimeout(() => {
            ctx.emit('mesh-rpc:request-timeout', { to: target, method, path })
            cancel(requestId, new Error(`mesh-rpc: request ${method} ${path} to ${target} timed out after ${timeoutMs}ms`))
          }, timeoutMs)
          pending.set(requestId, { target, resolve, reject, signal, onAbort, timer })
          signal?.addEventListener('abort', onAbort, { once: true })
          // Return the promise before a slow send can time out or reject it.
          Promise.resolve().then(() => {
            if (!pending.has(requestId)) return
            return send(target, { kind: 'rpc-request', requestId, method, path, headers, ...encoded })
          }).catch(error => settle(requestId, error))
        })
      }
      return {
        api: { request },
        teardown() {
          if (closed) return
          closed = true
          unsubscribe()
          for (const id of pending.keys()) settle(id, new Error('mesh-rpc: service torn down while a request was still in flight'))
          for (const { controller, timer } of incoming.values()) { clearTimeout(timer); controller.abort(abortError()) }
        },
      }
    },
  }
}

export { DEFAULT_ENVELOPE_TYPE, DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_MAX_BODY_BYTES }
