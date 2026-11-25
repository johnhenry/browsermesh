/**
 * peer-join-gate.mjs -- a held join for a peer registry: the offering side approves, the joining side confirms
 * ("keep"), and nothing flows until both have happened.
 *
 *   offering side                                  joining side
 *   -------------                                  ------------
 *   request(peer)        pending
 *   approve(peer)        approved  -- tell the joiner -->   approved(offer)   approved  (held)
 *                                                           keep()           install(), then tell the offering side
 *   kept(peer)           kept      <-- "kept" -----------   kept
 *   leave(peer)          (either side, any time, removes what was added)  leave()
 *
 * "Flows" means the registry: on the offering side the peer is added to the `PeerRegistry` (with the approved
 * scopes) only at `kept()`, never at `approve()`; on the joining side whatever the caller's `install` hook sets up
 * (a route, a registry entry) runs only at `keep()`. An approval that is not kept in time runs out on both sides
 * (default 5 minutes; the offering side waits `graceMs` longer, because the joiner's own clock starts when it
 * hears the approval). A request nobody answers also runs out. Either side can leave at any point.
 *
 * This is a state machine and nothing else: no UI (an application shows the pending list and the Keep button),
 * no transport (the application carries the messages: request, approved, kept, leave), and no timer of its own
 * (the clock is injected, like `PeerRegistry`'s). It is off unless a caller builds one; nothing else in the
 * package uses it, and it adds nothing to the wire.
 *
 * No browser-only imports at module level.
 */

// A label is text the other side controls: no escape sequences, control, bidi or invisible characters, one line,
// at most 64 code points. (Kept local so this module needs nothing newer than the primitives it already depends on.)
const ESC_SEQ = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[PX^_][^\u001b]*(?:\u001b\\)?|[@-Z\\-_]|.)?|\u009b[0-?]*[ -/]*[@-~]|\u009d[^\u0007\u009c]*[\u0007\u009c]?/gsu
const BAD_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Co}]/gu
const MAX_LABEL_CHARS = 64
function sanitizeLabel(input) {
  if (typeof input !== 'string') return ''
  const head = input.length > MAX_LABEL_CHARS * 8 ? input.slice(0, MAX_LABEL_CHARS * 8) : input
  const s = head.replace(ESC_SEQ, '').replace(BAD_CHARS, '').replace(/\s+/g, ' ').trim().normalize('NFC')
  return [...s].slice(0, MAX_LABEL_CHARS).join('').trim()
}

/**
 * The defaults: an approval waits 5 minutes to be kept, a request waits 5 minutes to be answered, the offering side
 * waits 10 s longer than the joiner for the "kept" message to arrive (the joiner's own clock starts when it hears the
 * approval), and 16 joins may be waiting (pending or approved, not yet kept) at once.
 */
export const JOIN_GATE_DEFAULTS = Object.freeze({ keepTimeoutMs: 300_000, requestTimeoutMs: 300_000, graceMs: 10_000, maxWaiting: 16 })

/** The states a join can be seen in; a join that ended (denied, expired, left) is gone and `state()` says null. */
export const JOIN_STATE = Object.freeze({ PENDING: 'pending', APPROVED: 'approved', KEPT: 'kept' })

const MAX_PEER_ID_CHARS = 128
const MAX_SCOPES = 64
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

const defaultClock = () => ({
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
})

function positive(name, value) {
  if (!(typeof value === 'number' && value > 0)) throw new TypeError(`${name} must be a positive number`)
  return Math.min(value, MAX_TIMER_DELAY_MS)
}

/** A tiny listener set whose listeners can never break the machine. */
function emitter() {
  const listeners = new Set()
  return {
    on(cb) {
      if (typeof cb !== 'function') throw new TypeError('on: a function is required')
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    emit(event) {
      for (const cb of [...listeners]) { try { cb(event) } catch { /* a listener's bug is the listener's */ } }
    },
  }
}

/**
 * The offering side of a held join.
 *
 * @param {object} opts
 * @param {{ addPeer: Function, removePeer: Function }} opts.registry - a `PeerRegistry` (or the same two methods)
 * @param {{ now: () => number, setTimeout: Function, clearTimeout: Function }} [opts.clock]
 * @param {number} [opts.keepTimeoutMs=300000] - how long an approval waits for the joiner to keep it
 * @param {number} [opts.graceMs=10000] - extra wait on this side for the "kept" message to arrive
 * @param {number} [opts.requestTimeoutMs=300000] - how long a request waits to be approved or denied
 * @param {number} [opts.maxWaiting=16] - joins waiting (pending or approved) at once; more are refused
 * @param {string[]} [opts.scopes=[]] - scopes granted at `kept()` when `approve()` names none
 */
export function createOfferingJoinGate({
  registry,
  clock = defaultClock(),
  keepTimeoutMs = JOIN_GATE_DEFAULTS.keepTimeoutMs,
  graceMs = JOIN_GATE_DEFAULTS.graceMs,
  requestTimeoutMs = JOIN_GATE_DEFAULTS.requestTimeoutMs,
  maxWaiting = JOIN_GATE_DEFAULTS.maxWaiting,
  scopes: defaultScopes = [],
} = {}) {
  if (!registry || typeof registry.addPeer !== 'function' || typeof registry.removePeer !== 'function') {
    throw new TypeError('createOfferingJoinGate: a registry with addPeer and removePeer is required')
  }
  const keepMs = positive('keepTimeoutMs', keepTimeoutMs)
  const requestMs = positive('requestTimeoutMs', requestTimeoutMs)
  if (!(typeof graceMs === 'number' && graceMs >= 0)) throw new TypeError('graceMs must be zero or a positive number')
  if (!Number.isInteger(maxWaiting) || maxWaiting < 1) throw new TypeError('maxWaiting must be a positive integer')

  /** @type {Map<string, { state: string, label: string, scopes: string[], timer: any, since: number }>} */
  const joins = new Map()
  const { on, emit } = emitter()

  const waiting = () => { let n = 0; for (const j of joins.values()) if (j.state !== JOIN_STATE.KEPT) n++; return n }
  const event = (type, peerId, j, extra) => emit({ type, peerId, label: j?.label ?? '', at: clock.now(), ...extra })

  function end(peerId, type, extra) {
    const j = joins.get(peerId)
    if (!j) return null
    clock.clearTimeout(j.timer)
    joins.delete(peerId)
    event(type, peerId, j, extra)
    return j
  }

  function arm(peerId, j, ms, type) {
    clock.clearTimeout(j.timer)
    j.timer = clock.setTimeout(() => { if (joins.get(peerId) === j) end(peerId, type) }, ms)
  }

  return {
    on,

    /** A peer asks to join. @returns {{ ok: true, state: 'pending' } | { ok: false, reason: string }} */
    request(peerId, { label = '' } = {}) {
      if (typeof peerId !== 'string' || peerId === '' || peerId.length > MAX_PEER_ID_CHARS) return { ok: false, reason: 'bad-peer-id' }
      const existing = joins.get(peerId)
      if (existing) return { ok: false, reason: existing.state === JOIN_STATE.KEPT ? 'already-joined' : 'already-waiting' }
      if (waiting() >= maxWaiting) return { ok: false, reason: 'too-many-waiting' }
      const j = { state: JOIN_STATE.PENDING, label: sanitizeLabel(label), scopes: [], timer: null, since: clock.now() }
      joins.set(peerId, j)
      arm(peerId, j, requestMs, 'expired')
      event('request', peerId, j)
      return { ok: true, state: JOIN_STATE.PENDING }
    },

    /** The operator approves. Nothing is added to the registry yet: the joiner still has to keep it. */
    approve(peerId, { scopes } = {}) {
      const j = joins.get(peerId)
      if (!j || j.state !== JOIN_STATE.PENDING) return { ok: false, reason: 'no-request' }
      const list = Array.isArray(scopes) ? scopes.slice(0, MAX_SCOPES) : [...defaultScopes]
      j.state = JOIN_STATE.APPROVED
      j.scopes = list
      arm(peerId, j, keepMs + graceMs, 'expired')
      event('approved', peerId, j, { expiresAt: clock.now() + keepMs + graceMs })
      return { ok: true, state: JOIN_STATE.APPROVED }
    },

    /** The operator refuses. */
    deny(peerId) {
      const j = joins.get(peerId)
      if (!j || j.state !== JOIN_STATE.PENDING) return { ok: false, reason: 'no-request' }
      end(peerId, 'denied')
      return { ok: true }
    },

    /**
     * The joiner says it kept the join (its install is done). Only an approval that is still waiting can be kept;
     * only now is the peer added to the registry, with the approved scopes.
     */
    kept(peerId) {
      const j = joins.get(peerId)
      if (!j || j.state !== JOIN_STATE.APPROVED) return { ok: false, reason: 'not-approved' }
      try {
        registry.addPeer(peerId, j.label || undefined, j.scopes.length ? j.scopes : undefined)
      } catch (err) {
        // The join stays approved, and its deadline still runs: the joiner may say it again.
        return { ok: false, reason: 'install-failed', error: err?.message || String(err) }
      }
      clock.clearTimeout(j.timer)
      j.timer = null
      j.state = JOIN_STATE.KEPT
      event('kept', peerId, j)
      return { ok: true, state: JOIN_STATE.KEPT }
    },

    /** Either side leaves: a waiting join is discarded, a kept one is removed from the registry. */
    leave(peerId, { by = 'local' } = {}) {
      const j = joins.get(peerId)
      if (!j) return { ok: false, reason: 'no-such-join' }
      if (j.state === JOIN_STATE.KEPT) { try { registry.removePeer(peerId) } catch { /* already gone */ } }
      end(peerId, 'left', { by })
      return { ok: true }
    },

    /** @returns {'pending'|'approved'|'kept'|null} */
    state(peerId) { return joins.get(peerId)?.state ?? null },
    isActive(peerId) { return joins.get(peerId)?.state === JOIN_STATE.KEPT },
    list() { return [...joins].map(([peerId, j]) => ({ peerId, state: j.state, label: j.label, since: j.since })) },

    /** Stop every timer and drop every join that is still waiting (kept joins stay in the registry). */
    dispose() {
      for (const [peerId, j] of joins) { clock.clearTimeout(j.timer); if (j.state !== JOIN_STATE.KEPT) joins.delete(peerId) }
      joins.clear()
    },
  }
}

/**
 * The joining side of a held join: it holds the offering side's approval and does nothing with it until `keep()`.
 *
 * @param {object} opts
 * @param {(offer: { peerId: string, label: string }) => void|Promise<void>} opts.install - what keeping sets up
 *   (a route, a registry entry). It runs only at `keep()`. If it throws the approval stays held.
 * @param {(offer: { peerId: string, label: string }) => void|Promise<void>} [opts.uninstall] - undoes `install`
 * @param {{ now: () => number, setTimeout: Function, clearTimeout: Function }} [opts.clock]
 * @param {number} [opts.keepTimeoutMs=300000]
 */
export function createJoiningJoinGate({ install, uninstall, clock = defaultClock(), keepTimeoutMs = JOIN_GATE_DEFAULTS.keepTimeoutMs } = {}) {
  if (typeof install !== 'function') throw new TypeError('createJoiningJoinGate: an install function is required')
  const keepMs = positive('keepTimeoutMs', keepTimeoutMs)
  const { on, emit } = emitter()

  /** @type {null | { state: 'approved'|'installing'|'kept', peerId: string, label: string, timer: any, expired: boolean }} */
  let held = null
  const event = (type, h, extra) => emit({ type, peerId: h?.peerId, label: h?.label ?? '', at: clock.now(), ...extra })

  const undo = async (h) => { try { await uninstall?.({ peerId: h.peerId, label: h.label }) } catch { /* best effort */ } }

  return {
    on,

    /** The offering side approved. Held until `keep()`; runs out after `keepTimeoutMs`. */
    approved({ peerId, label = '' } = {}) {
      if (typeof peerId !== 'string' || peerId === '' || peerId.length > MAX_PEER_ID_CHARS) return { ok: false, reason: 'bad-peer-id' }
      if (held) return { ok: false, reason: 'already-waiting' }
      const h = { state: 'approved', peerId, label: sanitizeLabel(label), timer: null, expired: false }
      h.timer = clock.setTimeout(() => {
        if (held !== h || h.state === 'kept') return
        h.expired = true
        if (h.state === 'approved') held = null // installing: `keep()` finishes and undoes it
        event('expired', h)
      }, keepMs)
      held = h
      event('approved', h, { expiresAt: clock.now() + keepMs })
      return { ok: true, state: 'approved' }
    },

    /** The joiner presses Keep: run `install`, then the caller tells the offering side. */
    async keep() {
      const h = held
      if (!h || h.state !== 'approved') return { ok: false, reason: 'not-approved' }
      h.state = 'installing'
      try {
        await install({ peerId: h.peerId, label: h.label })
      } catch (err) {
        if (!h.expired && held === h) h.state = 'approved'
        return { ok: false, reason: 'install-failed', error: err?.message || String(err) }
      }
      if (h.expired || held !== h) {
        // The approval ran out, or the joiner left, while the install was in flight: take it back.
        await undo(h)
        if (held === h) held = null
        return { ok: false, reason: 'expired' }
      }
      clock.clearTimeout(h.timer)
      h.timer = null
      h.state = 'kept'
      event('kept', h)
      return { ok: true, state: 'kept', peerId: h.peerId }
    },

    /** Either side leaves: a held approval is discarded, a kept join is uninstalled. */
    async leave({ by = 'local' } = {}) {
      const h = held
      if (!h) return { ok: false, reason: 'no-such-join' }
      held = null
      clock.clearTimeout(h.timer)
      if (h.state === 'kept') await undo(h)
      event('left', h, { by })
      return { ok: true }
    },

    /** @returns {'approved'|'installing'|'kept'|null} */
    state() { return held ? held.state : null },
    isActive() { return held?.state === 'kept' },
    dispose() { if (held) clock.clearTimeout(held.timer); held = null },
  }
}
