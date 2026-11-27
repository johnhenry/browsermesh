/**
 * limits.mjs -- the ingress's bounds, their defaults, and the two small mechanisms that apply them.
 */

export const INGRESS_LIMIT_DEFAULTS = Object.freeze({
  /** Request body, bytes: what the ingress will carry for one request (streamed, never held whole). `Infinity` only by choice. */
  maxRequestBodyBytes: 32 * 1024 * 1024,
  /** A request body the ingress must hold whole (an older provider, a signed request, the mesh-rpc fallback), bytes. The lower of this and `maxRequestBodyBytes` applies. */
  maxBufferedBodyBytes: 1024 * 1024,
  /** Whole request carrying a body, ms: from `handle()` to the last response byte (a request with no body has `timeoutMs`). */
  uploadTimeoutMs: 300_000,
  /** Requests with a body being sent to one provider at once. */
  maxUploadsPerProvider: 4,
  /** Response body, bytes. */
  maxResponseBytes: 8 * 1024 * 1024,
  /** Whole request, ms: from `handle()` to the last response byte. */
  timeoutMs: 30_000,
  /** Longest wait between two request-body chunks from the client, ms. */
  bodyIdleMs: 10_000,
  /** Longest wait between two response chunks from the provider, ms. */
  responseIdleMs: 15_000,
  /** Time to open the channel to a provider, ms. */
  openTimeoutMs: 10_000,
  /** How long a request for a pod told to be expected (`expect()`, a held name) waits for the link, ms. */
  linkWaitMs: 5_000,
  maxHeaderCount: 64,
  maxHeaderBytes: 16 * 1024,
  maxTargetLength: 2048,
  maxInflight: 64,
  maxInflightPerClient: 8,
  maxInflightPerProvider: 16,
  /** Requests per window, per client address and per provider. */
  clientRate: Object.freeze({ limit: 120, windowMs: 60_000 }),
  providerRate: Object.freeze({ limit: 600, windowMs: 60_000 }),
  /** Distinct client addresses / providers tracked at once (bounds this module's own memory). */
  maxTracked: 10_000,
})

const POSITIVE = ['maxBufferedBodyBytes', 'maxResponseBytes', 'timeoutMs', 'uploadTimeoutMs', 'bodyIdleMs', 'responseIdleMs', 'openTimeoutMs', 'linkWaitMs', 'maxHeaderCount',
  'maxHeaderBytes', 'maxTargetLength', 'maxInflight', 'maxInflightPerClient', 'maxInflightPerProvider', 'maxUploadsPerProvider', 'maxTracked']
/** Bounds that may be lifted, and only by saying `Infinity`. */
const MAY_BE_INFINITE = ['maxRequestBodyBytes']

/** @returns {typeof INGRESS_LIMIT_DEFAULTS} defaults overlaid with `given`, each value checked */
export function resolveLimits(given = {}) {
  const out = { ...INGRESS_LIMIT_DEFAULTS, ...given }
  for (const name of POSITIVE) if (!Number.isSafeInteger(out[name]) || out[name] <= 0) throw new TypeError(`ingress limits: ${name} must be a positive integer`)
  for (const name of MAY_BE_INFINITE) if (out[name] !== Infinity && (!Number.isSafeInteger(out[name]) || out[name] <= 0)) throw new TypeError(`ingress limits: ${name} must be a positive integer (or Infinity, to lift it)`)
  for (const name of ['clientRate', 'providerRate']) {
    const r = out[name]
    if (!r || !Number.isSafeInteger(r.limit) || r.limit <= 0 || !Number.isSafeInteger(r.windowMs) || r.windowMs <= 0) throw new TypeError(`ingress limits: ${name} must be { limit, windowMs } of positive integers`)
  }
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

/** Counts of work in flight per key (`'*'` is the global one). `enter` returns a release function or null when over a cap. */
export function createInflight({ maxTracked = 10_000 } = {}) {
  const per = new Map()
  return {
    count: (key) => per.get(key) ?? 0,
    /** @returns {(() => void)|null} */
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

/** Parse `30s`, `500ms`, `2m` or a bare number of milliseconds. */
export function parseDuration(text) {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/.exec(String(text).trim())
  if (!m) throw new TypeError(`not a duration: ${text}`)
  const n = Number(m[1]) * ({ ms: 1, s: 1000, m: 60_000 }[m[2] ?? 'ms'])
  if (!Number.isFinite(n) || n <= 0) throw new TypeError(`not a duration: ${text}`)
  return Math.round(n)
}

/** Parse `65536`, `64k`, `64KiB`, `8m` or `8MiB` as bytes. */
export function parseBytes(text) {
  const m = /^(\d+)\s*(b|k|kb|kib|m|mb|mib)?$/i.exec(String(text).trim())
  if (!m) throw new TypeError(`not a size: ${text}`)
  const unit = (m[2] ?? 'b').toLowerCase()
  const n = Number(m[1]) * (unit.startsWith('k') ? 1024 : unit.startsWith('m') ? 1024 * 1024 : 1)
  if (!Number.isSafeInteger(n) || n <= 0) throw new TypeError(`not a size: ${text}`)
  return n
}
