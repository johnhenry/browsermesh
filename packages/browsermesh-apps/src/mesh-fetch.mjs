/**
 * Fetch-shaped mesh access. The default bodyMode ('structured') retains the
 * existing JSON-oriented API. Use bodyMode: 'http', or pass a Request, to send
 * exact HTTP body bytes, including multipart forms. Bodies are buffered and
 * bounded, not streamed. Resource authorization belongs in the responder.
 */
import { parseMeshRequest } from '@johnhenry/browsermesh-primitives'
import { DEFAULT_MAX_BODY_BYTES } from './mesh-rpc.mjs'

const abortError = signal => signal?.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError')

export function createBrowserMeshFetch(meshRpcApi, { bodyMode = 'structured', maxBodyBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  if (!meshRpcApi || typeof meshRpcApi.request !== 'function') throw new Error('createBrowserMeshFetch: a mesh-rpc api with a request(podId, {...}) method is required')
  if (!['structured', 'http'].includes(bodyMode)) throw new TypeError('createBrowserMeshFetch: bodyMode must be structured or http')
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) throw new TypeError('createBrowserMeshFetch: maxBodyBytes must be a positive integer')
  return function browserMeshFetch(input, init = {}) {
    const isRequest = typeof Request !== 'undefined' && input instanceof Request
    const url = isRequest ? input.url : String(input)
    const parsed = parseMeshRequest(url)
    if (!parsed) throw new TypeError(`browserMeshFetch: '${url}' is not a valid mesh:// or *.mesh.local URL`)
    return performMeshFetch(meshRpcApi, parsed, input, init || {}, { isRequest, bodyMode, maxBodyBytes })
  }
}

async function performMeshFetch(api, { podId, path }, input, init, { isRequest, bodyMode, maxBodyBytes }) {
  let method, headers, body, signal
  if (isRequest || bodyMode === 'http') {
    // Native Request constructs correct multipart headers and BodyInit bytes.
    const request = new Request(input, { ...init, duplex: 'half' })
    method = request.method
    headers = Object.fromEntries(request.headers)
    signal = request.signal
    if (signal.aborted) throw abortError(signal)
    body = request.body ? await readBody(request.body, maxBodyBytes, signal) : undefined
  } else {
    method = (init.method || 'GET').toUpperCase()
    headers = normalizeHeaders(init.headers)
    signal = init.signal
    if (signal?.aborted) throw abortError(signal)
    body = init.body
    if (body === null || body === undefined || method === 'GET' || method === 'HEAD') body = undefined
    else if (typeof body === 'string') { try { body = JSON.parse(body) } catch { /* existing structured-text convention */ } }
  }
  const result = await api.request(podId, { method, path, headers, body }, { signal })
  return buildResponse(result, method)
}

async function readBody(stream, limit, signal) {
  const reader = stream.getReader(), parts = []
  let size = 0
  const onAbort = () => { reader.cancel(abortError(signal)).catch(() => {}) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    for (;;) {
      if (signal.aborted) throw abortError(signal)
      const { value, done } = await reader.read()
      if (signal.aborted) throw abortError(signal)
      if (done) break
      if (!(value instanceof Uint8Array)) throw new TypeError('browserMeshFetch: body stream must contain bytes')
      size += value.byteLength
      if (size > limit) throw new RangeError('browserMeshFetch: body exceeds maxBodyBytes')
      parts.push(value.slice())
    }
    const body = new Uint8Array(size)
    let offset = 0
    for (const part of parts) { body.set(part, offset); offset += part.byteLength }
    return body
  } catch (error) {
    // A producer may never finish its cancellation hook. Local rejection must
    // not wait for cooperation from that producer.
    reader.cancel(error).catch(() => {})
    throw error
  } finally {
    signal.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
}

function normalizeHeaders(value) {
  if (!value) return {}
  return Object.fromEntries(new Headers(value))
}

function buildResponse(result, method) {
  const status = typeof result?.status === 'number' ? result.status : 200
  const body = result?.body
  const binary = body instanceof ArrayBuffer || ArrayBuffer.isView(body)
  const headers = result?.headers && Object.keys(result.headers).length
    ? result.headers : { 'content-type': binary ? 'application/octet-stream' : 'application/json' }
  const forbidden = method === 'HEAD' || [204, 205, 304].includes(status) || body === null || body === undefined
  const bytes = ArrayBuffer.isView(body) ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength) : body
  return new Response(forbidden ? null : binary || typeof body === 'string' ? bytes : JSON.stringify(body), { status, headers })
}
