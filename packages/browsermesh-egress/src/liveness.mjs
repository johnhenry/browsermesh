/**
 * liveness.mjs -- the keep-alive of an egress channel, the same at both ends.
 *
 * Nothing in a data channel says when the other end was killed outright: the transport's own timers took about four minutes to
 * (in a measurement with a real WebRTC link on both ends). So each end sends a small `ping` request on the protocol channel
 * every `intervalMs`, answers the other's with `{ ok: true }`, and declares the other end gone when NOTHING has been heard from
 * it for `misses` intervals: an answer to a ping, a ping of its own, any message of the protocol.
 *
 * Compatibility (protocol version 1 does not change): `ping` is one more request method on the same channel. A peer that does
 * not know it (0.1.1, 0.2.0) answers method-not-found, and an answer of any kind from the peer is proof it is there, so an older
 * peer is neither pinged to death nor declared gone for lacking the method. A peer that answers nothing at all, because it is
 * gone, is the only one declared gone.
 *
 * No `node:` import.
 */

export const PING_METHOD = 'ping'
/** Every 5 s, three silent intervals: a peer that vanished is noticed within about 15 s. */
export const KEEPALIVE_DEFAULTS = Object.freeze({ intervalMs: 5000, misses: 3 })

/** @returns {{ intervalMs: number, misses: number } | null} the settings, or null for `false` (off). Throws TypeError. */
export function resolveKeepAlive(given, who = 'keepAlive') {
  if (given === false) return null
  if (given === undefined || given === true) return { ...KEEPALIVE_DEFAULTS }
  if (!given || typeof given !== 'object' || Array.isArray(given)) throw new TypeError(`${who} is false, true or { intervalMs, misses }`)
  for (const name of Object.keys(given)) if (!Object.hasOwn(KEEPALIVE_DEFAULTS, name)) throw new TypeError(`${who}.${name} is not a setting (known: intervalMs, misses)`)
  const out = { ...KEEPALIVE_DEFAULTS, ...given }
  for (const [k, v] of Object.entries(out)) if (!Number.isSafeInteger(v) || v <= 0) throw new TypeError(`${who}.${k} must be a positive integer`)
  return out
}

/** Answers `ping` on a channel. Registered whether or not this end sends any, so a peer that does is answered. */
export function answerPings(channel, onPing) {
  return channel.onRequest(PING_METHOD, () => { try { onPing?.() } catch { /* a counter */ } return { ok: true } })
}

// A peer's own answers to a ping that prove it is there: it answered, with an error of its own. Not proof: this side timing the ping
// out, cancelling it, or the channel being closed.
const PEER_ANSWERS = new Set(['method-not-found', 'too-many-requests', 'handler-failed'])
const isPeerAnswer = (e) => e && typeof e === 'object' && (e.code === -32601 || e.code === -32002 || e.code === -32603 || PEER_ANSWERS.has(e.reason))

/**
 * Start watching `channel`. Sends a ping each interval; calls `onDead()` once when nothing has been heard for `misses` intervals.
 * @param {object} channel - a protocol channel (`request`, `onMessage`, `onClose`)
 * @param {{ intervalMs: number, misses: number, onDead: () => void, onPing?: () => void, onPong?: () => void,
 *   now?: () => number, setTimer?: Function, clearTimer?: Function }} opts
 * @returns {{ stop(): void, heard(): void }}
 */
export function startLiveness(channel, { intervalMs, misses, onDead, onPing, onPong, now = Date.now, setTimer = setInterval, clearTimer = clearInterval }) {
  let lastHeard = now()
  let lastPing = Number.NEGATIVE_INFINITY
  let over = false
  const heard = () => { lastHeard = now() }
  // A channel that is already closed has no listener list to join (and nothing to watch).
  let offMessage = () => {}
  try { if (typeof channel.onMessage === 'function') offMessage = channel.onMessage(heard) } catch { /* closed */ }
  const stop = () => {
    if (over) return
    over = true
    clearTimer(timer)
    try { offMessage() } catch { /* gone */ }
  }
  const tick = () => {
    if (over) return
    const t = now()
    if (t - lastHeard >= misses * intervalMs) { stop(); try { onDead() } catch { /* the owner's callback */ } return }
    if (t - lastPing < intervalMs) return
    lastPing = t
    try { onPing?.() } catch { /* a counter */ }
    // The ping may wait as long as the whole window: what it proves is an answer, whenever it comes inside that.
    let asked
    try { asked = Promise.resolve(channel.request(PING_METHOD, {}, { timeoutMs: misses * intervalMs })) } catch (e) { asked = Promise.reject(e) }
    asked.then(
      () => { if (!over) { heard(); try { onPong?.() } catch { /* a counter */ } } },
      (e) => { if (!over && isPeerAnswer(e)) { heard(); try { onPong?.() } catch { /* a counter */ } } },
    )
  }
  // Checked more often than the interval, so the end of a window is noticed close to it.
  const timer = setTimer(tick, Math.max(1, Math.floor(intervalMs / 4)))
  timer?.unref?.()
  return { stop, heard }
}
