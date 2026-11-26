/**
 * limits.mjs -- the provider's bounds, their defaults, and the small mechanisms that apply them.
 * Every bound is a finite positive whole number: there is no way to say "unlimited".
 */

const MiB = 1024 * 1024

export const EGRESS_LIMIT_DEFAULTS = Object.freeze({
  /** Open connections of one consumer. */
  maxConnectionsPerConsumer: 16,
  /** Open connections of all consumers. */
  maxConnections: 64,
  /** Connection attempts per window, per consumer (refused attempts count) and for all consumers. */
  connectRate: Object.freeze({ limit: 120, windowMs: 60_000 }),
  globalConnectRate: Object.freeze({ limit: 600, windowMs: 60_000 }),
  /** Name lookups per window, per consumer. */
  dnsRate: Object.freeze({ limit: 30, windowMs: 60_000 }),
  /** Bytes of one connection, both directions together. */
  maxBytesPerConnection: 64 * MiB,
  /** Bytes of one consumer, both directions together, per window (a fixed window that starts at its first byte). */
  maxBytesPerConsumer: Object.freeze({ limit: 1024 * MiB, windowMs: 24 * 60 * 60_000 }),
  /** Time to resolve, check and connect, ms. */
  connectTimeoutMs: 15_000,
  /** Longest time with nothing moving in either direction, ms. */
  idleMs: 5 * 60_000,
  /** Longest life of a connection, ms. */
  maxDurationMs: 60 * 60_000,
  /** Time the consumer has to open its sending stream after the answer, ms. */
  upWaitMs: 10_000,
  /** How often a long connection reports its bytes to `onMeter`, ms. */
  meterIntervalMs: 60_000,
  /** Malformed requests and refused streams of one channel before the channel is closed. */
  maxBadRequests: 8,
  /** Stream rules one consumer may break before it is cut off (the stream layer's `maxViolations`). */
  maxViolations: 8,
  /** Bytes of one stream a side holds unread, and so the most in flight per direction of a connection. */
  streamWindowBytes: 256 * 1024,
  /** Distinct consumers tracked at once (bounds this module's own memory). */
  maxTracked: 10_000,
  /** Fetch form: redirects followed for one request (each hop is authorised and address-checked again). */
  maxRedirects: 5,
  /** Fetch form: bytes of a request's or a response's header block. */
  maxHeaderBytes: 16 * 1024,
  /** Fetch form: time from the request to the final response head, every hop together, ms. */
  headersTimeoutMs: 30_000,
  /** Fetch form: bytes of a request body (the note's 1 MiB); more ends the fetch `byte-budget`. */
  maxFetchRequestBytes: 1 * MiB,
  /** Fetch form: bytes of a response body (the note's 8 MiB); more ends the body `byte-budget`. A bigger blob is a job for `connect()`, or a raised limit. */
  maxFetchResponseBytes: 8 * MiB,
  /** Fetch form: the whole life of a fetch, request to last body byte (the note's 30 s), ms; then `time-budget`. */
  maxFetchDurationMs: 30_000,
  /** UDP: bytes of one datagram's payload (1472 is what fits an Ethernet frame). */
  maxDatagramBytes: 1472,
  /** UDP: open flows of one consumer (each is one destination). */
  maxUdpFlowsPerConsumer: 8,
  /** UDP: nothing sent or received on a flow for this long closes it, ms. */
  udpIdleMs: 30_000,
  /** UDP: datagrams per window, per consumer, both directions; the rest are dropped, as a network would. */
  udpDatagramRate: Object.freeze({ limit: 500, windowMs: 1000 }),
  /** UDP: replies held for a consumer that is not reading; past this they are dropped. */
  udpOutboxBytes: 64 * 1024,
  /** UDP: datagrams of one flow, both directions together (dropped ones count too, so a flood ends the flow); the flow ends `datagram-budget`. */
  maxUdpDatagramsPerFlow: 50_000,
  /** UDP: payload bytes of one flow, both directions together; the flow ends `byte-budget`. */
  maxUdpBytesPerFlow: 16 * MiB,
  /**
   * UDP, replies are bounded by what the consumer sent (no amplification): each datagram the consumer sends earns its flow
   * `max(udpReplyFloorBytes, size * udpReplyRatio)` bytes of reply credit, up to `udpReplyCreditMaxBytes` held at once; a reply
   * larger than the credit left is dropped.
   */
  udpReplyRatio: 8,
  udpReplyFloorBytes: 4096,
  udpReplyCreditMaxBytes: 256 * 1024,
})

const POSITIVE = ['maxConnectionsPerConsumer', 'maxConnections', 'maxBytesPerConnection', 'connectTimeoutMs', 'idleMs', 'maxDurationMs', 'upWaitMs',
  'meterIntervalMs', 'maxBadRequests', 'maxViolations', 'streamWindowBytes', 'maxTracked', 'maxRedirects', 'maxHeaderBytes', 'headersTimeoutMs', 'maxFetchRequestBytes', 'maxFetchResponseBytes', 'maxFetchDurationMs',
  'maxDatagramBytes', 'maxUdpFlowsPerConsumer', 'udpIdleMs', 'udpOutboxBytes', 'maxUdpDatagramsPerFlow', 'maxUdpBytesPerFlow', 'udpReplyRatio', 'udpReplyFloorBytes', 'udpReplyCreditMaxBytes']
const RATES = ['connectRate', 'globalConnectRate', 'dnsRate', 'udpDatagramRate']

/** @returns {typeof EGRESS_LIMIT_DEFAULTS} defaults overlaid with `given`, each value checked */
export function resolveLimits(given = {}) {
  if (!given || typeof given !== 'object' || Array.isArray(given)) throw new TypeError('egress limits must be an object')
  for (const name of Object.keys(given)) if (!Object.hasOwn(EGRESS_LIMIT_DEFAULTS, name)) throw new TypeError(`egress limits: ${name} is not a limit (known: ${Object.keys(EGRESS_LIMIT_DEFAULTS).join(', ')})`)
  const out = { ...EGRESS_LIMIT_DEFAULTS, ...given }
  for (const name of POSITIVE) if (!Number.isSafeInteger(out[name]) || out[name] <= 0) throw new TypeError(`egress limits: ${name} must be a positive integer`)
  for (const name of RATES) {
    const r = out[name]
    if (!r || !Number.isSafeInteger(r.limit) || r.limit <= 0 || !Number.isSafeInteger(r.windowMs) || r.windowMs <= 0) throw new TypeError(`egress limits: ${name} must be { limit, windowMs } of positive integers`)
  }
  const b = out.maxBytesPerConsumer
  if (!b || !Number.isSafeInteger(b.limit) || b.limit <= 0 || !Number.isSafeInteger(b.windowMs) || b.windowMs <= 0) throw new TypeError('egress limits: maxBytesPerConsumer must be { limit, windowMs } of positive integers')
  if (out.streamWindowBytes > 16 * MiB) throw new TypeError('egress limits: streamWindowBytes is at most 16 MiB')
  if (out.maxDatagramBytes > 65507) throw new TypeError('egress limits: maxDatagramBytes is at most 65507 (the largest UDP payload)')
  if (out.maxRedirects > 20) throw new TypeError('egress limits: maxRedirects is at most 20')
  if (out.maxHeaderBytes > 1024 * 1024) throw new TypeError('egress limits: maxHeaderBytes is at most 1 MiB')
  if (out.udpReplyCreditMaxBytes < out.maxDatagramBytes) throw new TypeError('egress limits: udpReplyCreditMaxBytes must hold at least one datagram (maxDatagramBytes)')
  // A datagram is carried whole in one frame of one stream chunk; the stream window must hold a few.
  if (out.streamWindowBytes < 4 * (out.maxDatagramBytes + 2)) throw new TypeError('egress limits: streamWindowBytes must hold at least four datagrams (maxDatagramBytes + 2 each)')
  return out
}

/**
 * A fixed-window counter per key. `now` is injected so a test advances a clock instead of waiting for one.
 * Memory is bounded: past `maxTracked` keys, the oldest windows are forgotten first.
 */
export function createRateLimiter({ limit, windowMs }, { now = Date.now, maxTracked = 10_000 } = {}) {
  const windows = new Map() // key -> { start, count }
  return {
    /** @returns {{ ok: boolean, retryAfterMs: number }} */
    take(key) {
      const t = now()
      let w = windows.get(key)
      if (!w || t - w.start >= windowMs) {
        w = { start: t, count: 0 }
        windows.delete(key)
        windows.set(key, w)
        if (windows.size > maxTracked) windows.delete(windows.keys().next().value)
      }
      if (w.count >= limit) return { ok: false, retryAfterMs: Math.max(1, w.start + windowMs - t) }
      w.count += 1
      return { ok: true, retryAfterMs: 0 }
    },
    size: () => windows.size,
  }
}

/** Bytes per key in a fixed window. */
export function createByteBudget({ limit, windowMs }, { now = Date.now, maxTracked = 10_000 } = {}) {
  const windows = new Map() // key -> { start, used }
  const current = (key) => {
    const t = now()
    let w = windows.get(key)
    if (!w || t - w.start >= windowMs) {
      w = { start: t, used: 0 }
      windows.delete(key)
      windows.set(key, w)
      if (windows.size > maxTracked) windows.delete(windows.keys().next().value)
    }
    return w
  }
  return {
    used: (key) => current(key).used,
    /** @returns {boolean} true while the key is still within its budget after adding `n` */
    add(key, n) { const w = current(key); w.used += n; return w.used <= limit },
    spent: (key) => current(key).used >= limit,
    size: () => windows.size,
  }
}

/** Counts of work in flight per key. `enter` returns a release function or null when over a cap. */
export function createInflight({ maxTracked = 10_000 } = {}) {
  const per = new Map()
  return {
    count: (key) => per.get(key) ?? 0,
    enter(key, cap) {
      const n = per.get(key) ?? 0
      if (n >= cap) return null
      if (!per.has(key) && per.size >= maxTracked) return null
      per.set(key, n + 1)
      let done = false
      return () => {
        if (done) return
        done = true
        const m = (per.get(key) ?? 1) - 1
        if (m <= 0) per.delete(key)
        else per.set(key, m)
      }
    },
  }
}

/** Parse `30s`, `500ms`, `2m`, `1h` or a bare number of milliseconds. */
export function parseDuration(text) {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(String(text).trim())
  if (!m) throw new TypeError(`not a duration: ${text}`)
  const n = Number(m[1]) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? 'ms'])
  if (!Number.isFinite(n) || n <= 0) throw new TypeError(`not a duration: ${text}`)
  return Math.round(n)
}

/** Parse `65536`, `64k`, `64KiB`, `8m`, `64MiB` or `1g` as bytes. */
export function parseBytes(text) {
  const m = /^(\d+)\s*(b|k|kb|kib|m|mb|mib|g|gb|gib)?$/i.exec(String(text).trim())
  if (!m) throw new TypeError(`not a size: ${text}`)
  const unit = (m[2] ?? 'b').toLowerCase()
  const n = Number(m[1]) * (unit.startsWith('k') ? 1024 : unit.startsWith('m') ? MiB : unit.startsWith('g') ? 1024 * MiB : 1)
  if (!Number.isSafeInteger(n) || n <= 0) throw new TypeError(`not a size: ${text}`)
  return n
}
