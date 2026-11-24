/**
 * Small self-contained, binary-safe value codec for the message channel.
 *
 * Values: null, booleans, finite numbers, strings, Uint8Array (native bytes),
 * arrays and plain objects (string keys). `undefined` object members are
 * skipped; `undefined` inside an array becomes null. Anything else (functions,
 * symbols, bigint, NaN/Infinity, cycles, class instances other than typed
 * arrays/ArrayBuffer) throws a TypeError at encode time.
 *
 * Layout: one tag byte, then for ints a zigzag varint, for f64 8 big-endian
 * bytes, for string/bytes a varint length plus the payload, for array/map a
 * varint count followed by the items (map: key string, value). Every length
 * is checked against the bytes actually remaining before anything is
 * allocated, and depth is bounded, so a malformed frame cannot make the decoder
 * allocate more than its own size.
 */
const T_NULL = 0, T_FALSE = 1, T_TRUE = 2, T_INT = 3, T_F64 = 4, T_STR = 5, T_BYTES = 6, T_ARR = 7, T_MAP = 8
const MAX_DEPTH = 32
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true })

function viewOf(value) {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  return null
}

class Writer {
  constructor() { this.parts = []; this.length = 0 }
  byte(b) { this.parts.push(Uint8Array.of(b)); this.length += 1 }
  raw(bytes) { this.parts.push(bytes); this.length += bytes.byteLength }
  varint(n) {
    const out = []
    while (n >= 0x80) { out.push((n % 0x80) | 0x80); n = Math.floor(n / 0x80) }
    out.push(n)
    this.raw(Uint8Array.from(out))
  }
  done() {
    const out = new Uint8Array(this.length)
    let at = 0
    for (const part of this.parts) { out.set(part, at); at += part.byteLength }
    return out
  }
}

function write(w, value, depth, seen) {
  if (depth > MAX_DEPTH) throw new TypeError('channel codec: value nested too deeply')
  if (value === null || value === undefined) return w.byte(T_NULL)
  if (value === true) return w.byte(T_TRUE)
  if (value === false) return w.byte(T_FALSE)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('channel codec: numbers must be finite')
    if (Number.isSafeInteger(value) && !Object.is(value, -0)) {
      w.byte(T_INT)
      return w.varint(value >= 0 ? value * 2 : -value * 2 - 1)
    }
    w.byte(T_F64)
    const buf = new Uint8Array(8)
    new DataView(buf.buffer).setFloat64(0, value)
    return w.raw(buf)
  }
  if (typeof value === 'string') {
    const bytes = textEncoder.encode(value)
    w.byte(T_STR); w.varint(bytes.byteLength)
    return w.raw(bytes)
  }
  const bytes = viewOf(value)
  if (bytes) {
    w.byte(T_BYTES); w.varint(bytes.byteLength)
    return w.raw(bytes)
  }
  if (typeof value !== 'object') throw new TypeError(`channel codec: cannot encode a ${typeof value}`)
  if (seen.has(value)) throw new TypeError('channel codec: cyclic value')
  seen.add(value)
  if (Array.isArray(value)) {
    w.byte(T_ARR); w.varint(value.length)
    for (let i = 0; i < value.length; i++) write(w, value[i], depth + 1, seen)
  } else {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) throw new TypeError('channel codec: only plain objects can be encoded')
    const keys = Object.keys(value).filter(k => value[k] !== undefined)
    w.byte(T_MAP); w.varint(keys.length)
    for (const key of keys) {
      const k = textEncoder.encode(key)
      w.varint(k.byteLength); w.raw(k)
      write(w, value[key], depth + 1, seen)
    }
  }
  seen.delete(value)
}

/** @param {*} value @returns {Uint8Array} */
export function encodeValue(value) {
  const w = new Writer()
  write(w, value, 0, new Set())
  return w.done()
}

class Reader {
  constructor(bytes) { this.bytes = bytes; this.at = 0 }
  left() { return this.bytes.byteLength - this.at }
  byte() {
    if (this.at >= this.bytes.byteLength) throw new RangeError('channel codec: truncated value')
    return this.bytes[this.at++]
  }
  varint() {
    let n = 0, scale = 1
    for (let i = 0; i < 8; i++) {
      const b = this.byte()
      n += (b & 0x7f) * scale
      if (!(b & 0x80)) return n
      scale *= 0x80
    }
    throw new RangeError('channel codec: varint too long')
  }
  take(len) {
    if (!Number.isSafeInteger(len) || len < 0 || len > this.left()) throw new RangeError('channel codec: length exceeds the frame')
    const out = this.bytes.subarray(this.at, this.at + len)
    this.at += len
    return out
  }
}

function read(r, depth) {
  if (depth > MAX_DEPTH) throw new RangeError('channel codec: value nested too deeply')
  switch (r.byte()) {
    case T_NULL: return null
    case T_FALSE: return false
    case T_TRUE: return true
    case T_INT: { const n = r.varint(); return n % 2 ? -(n + 1) / 2 : n / 2 }
    case T_F64: return new DataView(r.take(8).slice().buffer).getFloat64(0)
    case T_STR: return textDecoder.decode(r.take(r.varint()))
    case T_BYTES: return r.take(r.varint()).slice()
    case T_ARR: {
      const count = r.varint()
      if (count > r.left()) throw new RangeError('channel codec: count exceeds the frame')
      const out = []
      for (let i = 0; i < count; i++) out.push(read(r, depth + 1))
      return out
    }
    case T_MAP: {
      const count = r.varint()
      if (count > r.left()) throw new RangeError('channel codec: count exceeds the frame')
      const out = {}
      for (let i = 0; i < count; i++) {
        const key = textDecoder.decode(r.take(r.varint()))
        // defineProperty so a "__proto__" key stays an own data member.
        Object.defineProperty(out, key, { value: read(r, depth + 1), enumerable: true, writable: true, configurable: true })
      }
      return out
    }
    default: throw new TypeError('channel codec: unknown tag')
  }
}

/** @param {Uint8Array} bytes @returns {*} */
export function decodeValue(bytes) {
  const r = new Reader(bytes)
  const value = read(r, 0)
  if (r.left() !== 0) throw new RangeError('channel codec: trailing bytes')
  return value
}

/** Bytes -> base64 text; the wire envelope is JSON so this stays internal to the framing. */
export function toBase64(bytes) {
  let text = ''
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(text)
}
/** Base64 text -> bytes, refusing anything over `maxBytes` before decoding. */
export function fromBase64(text, maxBytes) {
  if (typeof text !== 'string') throw new TypeError('channel codec: expected base64 text')
  if (text.length > 4 * Math.ceil(maxBytes / 3)) throw new RangeError('channel codec: chunk exceeds the limit')
  if (text.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new TypeError('channel codec: invalid base64')
  const binary = atob(text)
  if (binary.length > maxBytes) throw new RangeError('channel codec: chunk exceeds the limit')
  return Uint8Array.from(binary, ch => ch.charCodeAt(0))
}
