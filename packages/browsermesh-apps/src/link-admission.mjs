/**
 * link-admission.mjs -- a transport-neutral place to hold a link whose peer is not yet known.
 *
 * A link is `restricted` (it carries only an admission exchange, owned by one `handler`), then `promoted` (the transport adopts it
 * as a normal link) or `closed`. The seam owns the cap on restricted links, the deadline, one-shot promote/close, the frame cap
 * and the counters; a transport hands it a CHANNEL and decides nothing itself. Design: `docs/design/link-admission.md`.
 *
 *   const admission = createLinkAdmission({ decide, handler, onEvent })
 *   admission.admit({ peerKey, transport, proven, channel })          // wsh: WshPeerLinks({ admission }) calls this
 *   admission.gate({ peerKey, transport, proven, adapter, adopt })    // a MeshTransport-shaped inbound link (WebRTC)
 *
 * What a restricted link guarantees: no frame of it reaches anything but `handler`, and nothing is sent on it but what
 * `handler` sends. It holds because the transport does not adopt the link until `promote()`.
 *
 * No browser-only imports.
 */

const VERDICTS = new Set(['allow', 'deny', 'restrict'])
const DEFAULT_MAX_RESTRICTED = 8
const DEFAULT_DEADLINE_MS = 10_000
const DEFAULT_MAX_FRAME_BYTES = 16 * 1024

const encoder = new TextEncoder()

/** Size of a frame for the cap: text in UTF-8 bytes, binary in bytes, anything else as its JSON text. */
function frameSize(frame) {
  if (typeof frame === 'string') return frame.length * 3 > 1 << 30 ? Infinity : encoder.encode(frame).length
  if (frame instanceof Uint8Array || ArrayBuffer.isView(frame)) return frame.byteLength
  if (frame instanceof ArrayBuffer) return frame.byteLength
  try { return encoder.encode(JSON.stringify(frame) ?? '').length } catch { return Infinity }
}

/** A text frame that is a JSON object is the object; everything else is as it came. */
function normalize(frame) {
  if (typeof frame !== 'string' || frame[0] !== '{') return frame
  try {
    const v = JSON.parse(frame)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : frame
  } catch { return frame }
}

const isThenable = (v) => v && typeof v.then === 'function'

/**
 * @param {object} opts
 * @param {number} [opts.maxRestricted=8] - Restricted links open at once; a link over it is refused with `restricted-full`.
 * @param {number} [opts.deadlineMs=10000] - A link still restricted this long after `admit()` is closed with reason `deadline`.
 * @param {number} [opts.maxFrameBytes=16384] - Larger frames, either way, are dropped (inbound) or refused (outbound) and counted.
 * @param {(info: { peerKey: string, transport: string, proven: boolean }) => 'allow'|'deny'|'restrict'|Promise<'allow'|'deny'|'restrict'>} opts.decide
 *   A throw, a rejection or any other value is a deny.
 * @param {(link: { peerKey: string, transport: string, proven: boolean, send: (frame: object) => any, onFrame: (cb: (frame: any) => any) => void, onClose: (cb: (reason: string) => void) => void, promote: () => boolean, close: (reason?: string) => boolean }) => any} opts.handler
 *   Called once per restricted link, synchronously inside `admit()`, and owns the exchange. A throw or a rejection closes the link
 *   with `handler-error`. Inbound text frames that are JSON objects arrive as objects.
 * @param {(event: { type: string, peerKey?: string, transport?: string, reason?: string }) => void} [opts.onEvent]
 *   `denied`, `refused`, `restricted`, `promoted`, `closed` (with `reason`), `frame-dropped`.
 */
export function createLinkAdmission({
  maxRestricted = DEFAULT_MAX_RESTRICTED, deadlineMs = DEFAULT_DEADLINE_MS, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES, decide, handler, onEvent,
} = {}) {
  if (typeof decide !== 'function') throw new TypeError('createLinkAdmission: decide is required')
  if (typeof handler !== 'function') throw new TypeError('createLinkAdmission: handler is required')
  for (const [name, v] of [['maxRestricted', maxRestricted], ['deadlineMs', deadlineMs], ['maxFrameBytes', maxFrameBytes]]) {
    if (!Number.isSafeInteger(v) || v < 1) throw new TypeError(`createLinkAdmission: ${name} must be a positive integer`)
  }

  const open = new Set()
  const stats = {
    opened: 0, promoted: 0, closed: 0, refusedFull: 0, deadlines: 0, denied: 0, allowed: 0,
    framesIn: 0, framesOut: 0, framesDropped: 0, framesRefusedOut: 0,
  }
  const emit = (event) => { try { onEvent?.(event) } catch { /* a listener may not break a link */ } }

  /** @returns {Promise<'allow'|'deny'|'restrict'>} */
  async function decideSafe({ peerKey, transport, proven }) {
    let verdict
    try { verdict = await decide({ peerKey, transport, proven }) } catch { verdict = 'deny' }
    if (!VERDICTS.has(verdict)) verdict = 'deny'
    if (verdict === 'deny') { stats.denied++; emit({ type: 'denied', peerKey, transport }) }
    if (verdict === 'allow') stats.allowed++
    return verdict
  }

  async function admit({ peerKey, transport, proven, channel }) {
    if (open.size >= maxRestricted) {
      stats.refusedFull++
      emit({ type: 'refused', peerKey, transport, reason: 'restricted-full' })
      try { channel.close('restricted-full') } catch { /* already gone */ }
      return { state: 'refused', reason: 'restricted-full' }
    }
    const rec = { state: 'restricted', timer: null, frameCb: null, closeCb: null }
    open.add(rec)
    stats.opened++

    function finish(reason, { fromPeer = false } = {}) {
      if (rec.state !== 'restricted') return false
      rec.state = 'closed'
      clearTimeout(rec.timer)
      open.delete(rec)
      stats.closed++
      if (reason === 'deadline') stats.deadlines++
      if (!fromPeer) { try { channel.close(reason) } catch { /* already gone */ } }
      emit({ type: 'closed', peerKey, transport, reason })
      return true
    }
    const notifyClosed = (reason) => { try { rec.closeCb?.(reason) } catch { /* handler's own */ } }
    const failHandler = () => { finish('handler-error') }

    const link = {
      peerKey, transport, proven: proven === true,
      send(frame) {
        if (rec.state !== 'restricted') throw new Error('link is not restricted')
        if (frameSize(frame) > maxFrameBytes) {
          stats.framesRefusedOut++
          throw new RangeError(`frame is over the restricted-link limit of ${maxFrameBytes} bytes`)
        }
        stats.framesOut++
        return channel.send(frame)
      },
      onFrame(cb) { rec.frameCb = typeof cb === 'function' ? cb : null },
      onClose(cb) { rec.closeCb = typeof cb === 'function' ? cb : null },
      promote() {
        if (rec.state !== 'restricted') return false
        rec.state = 'promoted'
        clearTimeout(rec.timer)
        open.delete(rec)
        rec.frameCb = null
        stats.promoted++
        try {
          channel.adopt()
        } catch {
          rec.state = 'closed'
          stats.closed++
          try { channel.close('adopt-failed') } catch { /* already gone */ }
          emit({ type: 'closed', peerKey, transport, reason: 'adopt-failed' })
          return false
        }
        emit({ type: 'promoted', peerKey, transport })
        return true
      },
      close(reason = 'closed-by-handler') { return finish(String(reason)) },
    }

    channel.onFrame((frame) => {
      if (rec.state !== 'restricted') return undefined
      if (frameSize(frame) > maxFrameBytes) {
        stats.framesDropped++
        emit({ type: 'frame-dropped', peerKey, transport })
        return undefined
      }
      if (!rec.frameCb) { stats.framesDropped++; return undefined }
      stats.framesIn++
      try {
        const out = rec.frameCb(normalize(frame))
        if (isThenable(out)) return out.catch(failHandler)
      } catch { failHandler() }
      return undefined
    })
    channel.onClose((reason) => {
      if (finish(String(reason ?? 'peer-closed'), { fromPeer: true })) notifyClosed(String(reason ?? 'peer-closed'))
    })
    rec.timer = setTimeout(() => { if (finish('deadline')) notifyClosed('deadline') }, deadlineMs)
    rec.timer.unref?.()

    emit({ type: 'restricted', peerKey, transport })
    try {
      const out = handler(link)
      if (isThenable(out)) out.catch(failHandler)
    } catch { failHandler() }
    return rec.state === 'restricted' ? { state: 'restricted' } : { state: 'closed' }
  }

  /**
   * Gate an inbound link shaped like a `MeshTransport` (`send`, `onMessage`, `onClose`, `close`): ask `decide`, then adopt it
   * (`allow`), close it (`deny`) or hold it restricted until the handler promotes it (`restrict`).
   * @param {{ peerKey: string, transport: string, proven: boolean, adapter: object, adopt: () => void }} info
   */
  async function gate({ peerKey, transport, proven, adapter, adopt }) {
    const verdict = await decideSafe({ peerKey, transport, proven })
    if (verdict === 'allow') { adopt(); return { state: 'allowed' } }
    if (verdict === 'deny') {
      try { adapter.close() } catch { /* already gone */ }
      return { state: 'denied' }
    }
    let sink = null
    let closeCb = null
    adapter.onMessage((data) => (sink ? sink(data) : undefined))
    adapter.onClose?.(() => { closeCb?.('peer-closed') })
    const channel = {
      send: (frame) => adapter.send(frame),
      onFrame: (cb) => { sink = cb },
      onClose: (cb) => { closeCb = cb },
      close: () => { sink = null; try { adapter.close() } catch { /* already gone */ } },
      adopt: () => { sink = null; adopt() },
    }
    return admit({ peerKey, transport, proven, channel })
  }

  return {
    decide: decideSafe,
    admit,
    gate,
    stats: () => ({ restricted: open.size, ...stats }),
    get restricted() { return open.size },
    maxFrameBytes,
  }
}

/**
 * `authorize` for `WshPeerLinks` with an admission seam. The inner authorizer (the registry's, or the caller's) is asked first and
 * its verdict kept when it allows; a peer it refuses is put to `admission.decide` with `transport: 'wsh'` and `proven: true`
 * (wsh has verified the key before `authorize` runs): `allow` is `true`, `restrict` is `{ restricted: true }`, `deny` is `false`.
 *
 * `{ restricted: true }` is returned ONLY when the call carries `ctx.restricted === true`, which a transport that understands the
 * verdict passes as `authorize(peer, { restricted: true })`. An older transport calls `authorize(peer)` and grants a full
 * `endpoint:mesh` on ANY truthy verdict, so for it a `restrict` decision is a refusal (and `onEvent` says so).
 *
 * @param {{ decide: Function }} admission
 * @param {(peer: object) => any} [inner]
 * @param {{ onEvent?: (event: { type: string, peerKey?: string, transport?: string, reason?: string }) => void }} [opts]
 */
export function createWshAdmissionAuthorize(admission, inner, { onEvent } = {}) {
  if (!admission || typeof admission.decide !== 'function') throw new TypeError('createWshAdmissionAuthorize: an admission seam is required')
  return async (peer, ctx) => {
    let verdict = false
    try { verdict = inner ? await inner(peer) : false } catch { return false }
    if (verdict) return verdict
    const decision = await admission.decide({ peerKey: peer.podId, transport: 'wsh', proven: true })
    if (decision === 'allow') return true
    if (decision !== 'restrict') return false
    if (ctx?.restricted === true) return { restricted: true }
    try {
      onEvent?.({ type: 'restricted-unsupported', peerKey: peer.podId, transport: 'wsh', reason: 'the wsh transport does not support restricted links (upgrade @johnhenry/browsermesh-transport); refused' })
    } catch { /* a listener may not break a link */ }
    return false
  }
}
