// An explicit envelope field distinguishes bytes from ordinary JSON objects.
// This works across JSON-only transports without reserving user object keys.
const encoder = new TextEncoder()
const tooLarge = () => new RangeError('mesh-rpc: body exceeds maxBodyBytes')
const viewOf = value => value instanceof ArrayBuffer ? new Uint8Array(value)
  : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null

export function encodeBody(body, limit) {
  const bytes = viewOf(body)
  if (bytes) {
    if (bytes.byteLength > limit) throw tooLarge()
    let text = ''
    for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192))
    return { body: btoa(text), bodyEncoding: 'base64' }
  }
  const text = JSON.stringify(body)
  if (text !== undefined && encoder.encode(text).byteLength > limit) throw tooLarge()
  return { body }
}

export function decodeBody(message, limit) {
  if (message.bodyEncoding === undefined) {
    encodeBody(message.body, limit)
    return message.body
  }
  if (message.bodyEncoding !== 'base64' || typeof message.body !== 'string') throw new TypeError('mesh-rpc: invalid body encoding')
  const text = message.body
  if (text.length > 4 * Math.ceil(limit / 3)) throw tooLarge()
  if (text.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new TypeError('mesh-rpc: invalid base64 body')
  const binary = atob(text)
  if (binary.length > limit) throw tooLarge()
  return Uint8Array.from(binary, ch => ch.charCodeAt(0))
}
