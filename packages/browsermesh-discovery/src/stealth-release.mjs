/**
 * stealth-release.mjs -- the on-demand share release round (item 4 of docs/design/discovery-records.md).
 *
 * `dealStealthShares` hands each holder its signed share once. When a group member later needs the secret, it asks the holders:
 * `requestShareRelease` sends each holder a signed request and collects the answers; a holder (`createShareHolder`) checks who is
 * asking before it says anything about what it holds, and answers with its share sealed to the requester (or a named refusal).
 * The reader then recombines exactly as for shares dealt up front (`reconstructStealthSecret`), `minEpoch` and `holders` included.
 *
 * Transport-agnostic: `holder.handle(fromPodId, request)` is the whole holder side, and a peer is `{ holder, publicKey, send }`.
 * Carry the messages over the protocol channel named `stealthReleaseChannel(agentId)` (`stealth:<agentId>:share:release`). An older
 * peer never opens that channel, so it is simply unreachable: nothing it understands changes.
 */
import { StealthError } from './stealth.mjs'
import { verifyStealthShare, reconstructStealthSecret } from './stealth-threshold.mjs'

const MAX_V = 1
const REQUEST_DOMAIN = 'browsermesh-stealth-release/1'
const TAG_DOMAIN = 'browsermesh-stealth-release/tag/1'
const SEAL_DOMAIN = 'browsermesh-stealth-release/seal/1'
const DEFAULTS = { freshnessMs: 60_000, maxRequestBytes: 4096, rate: { max: 10, windowMs: 60_000 }, maxInFlight: 16, replayCacheSize: 4096, timeoutMs: 5000 }

/** The names a holder (or the reader) gives for a refusal. */
export const RELEASE_REFUSALS = Object.freeze([
  'malformed', 'too-large', 'unsupported-version', 'wrong-holder', 'stale-request', 'rate-limited', 'bad-signature', 'replayed',
  'not-a-member', 'no-share', 'stale-epoch', 'unknown-holder', 'not-approved', 'bad-response',
])

/** The protocol-channel name the round travels on. */
export const stealthReleaseChannel = (agentId) => `stealth:${agentId}:share:release`

const te = new TextEncoder()
const td = new TextDecoder()
const u32 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])
function frame(...parts) {
  const chunks = parts.map((p) => (typeof p === 'string' ? te.encode(p) : p))
  const out = new Uint8Array(chunks.reduce((n, c) => n + 4 + c.length, 0))
  let at = 0
  for (const c of chunks) { out.set(u32(c.length), at); at += 4; out.set(c, at); at += c.length }
  return out
}
const toB64 = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') }
const B64U_RE = /^[A-Za-z0-9_-]*$/
function fromB64(str) {
  if (typeof str !== 'string' || !B64U_RE.test(str) || str.length % 4 === 1) throw new TypeError('not base64url')
  const bin = atob(str.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (str.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
const bad = (message) => new StealthError('bad-argument', message)

/**
 * The tag a request carries instead of the agent and group ids: `hex(SHA-256(frame(domain, groupId, agentId)))`.
 * @param {{ groupId: string, agentId: string }} p
 * @returns {Promise<string>}
 */
export async function stealthReleaseTag({ groupId, agentId }) {
  return hex(await sha256(frame(TAG_DOMAIN, groupId, agentId)))
}

const podIdOf = async (rawKey) => toB64(await sha256(rawKey))

function requestSigningBytes(r) {
  return frame(REQUEST_DOMAIN, 'request', r.tag, r.holder, r.requester, r.eph, String(r.iat), r.nonce, String(r.minEpoch))
}
function responseSigningBytes(id, holder, epk, iv, ct) {
  return frame(REQUEST_DOMAIN, 'response', id, holder, epk, iv, ct)
}

async function sealKey(secretBits, id, holder) {
  const base = await crypto.subtle.importKey('raw', secretBits, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: frame(SEAL_DOMAIN, id, holder) },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  )
}

/**
 * Build a signed release request for one holder.
 *
 * @param {object} p
 * @param {{ sign(bytes: Uint8Array): Promise<ArrayBuffer|Uint8Array>, rawPublicKey(): Promise<ArrayBuffer|Uint8Array> }} p.identity - the requester (a group member)
 * @param {string} p.holder - the holder's name (the label its share was dealt under)
 * @param {Uint8Array} [p.holderKey] - the holder's raw public key; when given, `open` verifies the response signature
 * @param {string} p.agentId
 * @param {string} p.groupId
 * @param {number} [p.minEpoch=0]
 * @param {() => number} [p.now]
 * @returns {Promise<{ request: object, open: (response: object) => Promise<{ ok: true, share: object } | { ok: false, reason: string }> }>}
 */
export async function createReleaseRequest({ identity, holder, holderKey, agentId, groupId, minEpoch = 0, now = Date.now }) {
  if (!identity || typeof identity.sign !== 'function' || typeof identity.rawPublicKey !== 'function') throw bad('identity (sign, rawPublicKey) is required')
  if (typeof holder !== 'string' || holder === '') throw bad('holder must be a non-empty string')
  if (!Number.isSafeInteger(minEpoch) || minEpoch < 0) throw bad('minEpoch must be a non-negative integer')
  const pair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])
  const request = {
    v: MAX_V, type: 'release', tag: await stealthReleaseTag({ groupId, agentId }), holder,
    requester: toB64(new Uint8Array(await identity.rawPublicKey())),
    eph: toB64(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))),
    iat: now(), nonce: toB64(crypto.getRandomValues(new Uint8Array(16))), minEpoch,
  }
  const signing = requestSigningBytes(request)
  request.sig = toB64(new Uint8Array(await identity.sign(signing)))
  const id = toB64(await sha256(signing))
  const verifyKey = holderKey ? await crypto.subtle.importKey('raw', holderKey, { name: 'Ed25519' }, false, ['verify']) : null

  const open = async (response) => {
    const fail = (reason) => ({ ok: false, reason })
    if (response === null || typeof response !== 'object' || response.v !== MAX_V) return fail('bad-response')
    if (response.type === 'refused') return fail(RELEASE_REFUSALS.includes(response.reason) ? response.reason : 'bad-response')
    if (response.type !== 'released' || response.holder !== holder || response.id !== id) return fail('bad-response')
    try {
      const ct = fromB64(response.ct)
      const iv = fromB64(response.iv)
      if (verifyKey && !(await crypto.subtle.verify('Ed25519', verifyKey, fromB64(response.sig), responseSigningBytes(id, holder, response.epk, response.iv, response.ct)))) return fail('bad-response')
      const theirs = await crypto.subtle.importKey('raw', fromB64(response.epk), { name: 'X25519' }, false, [])
      const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: theirs }, pair.privateKey, 256))
      const key = await sealKey(bits, id, holder)
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: frame(id, holder, response.epk) }, key, ct)
      const share = JSON.parse(td.decode(plain))
      return { ok: true, share }
    } catch { return fail('bad-response') }
  }
  return { request, open }
}

/**
 * Build a holder's `released` response: the share sealed to the request's ephemeral key and signed by the holder. Used by
 * `createShareHolder`; exported for custom holders (and for tests of a hostile one).
 */
export async function createReleaseResponse({ request, share, identity, holder }) {
  const id = toB64(await sha256(requestSigningBytes(request)))
  const pair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])
  const epk = toB64(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))
  const theirs = await crypto.subtle.importKey('raw', fromB64(request.eph), { name: 'X25519' }, false, [])
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: theirs }, pair.privateKey, 256))
  const key = await sealKey(bits, id, holder)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: frame(id, holder, epk) }, key, te.encode(JSON.stringify(share))))
  const ivB = toB64(iv)
  const ctB = toB64(ct)
  const sig = toB64(new Uint8Array(await identity.sign(responseSigningBytes(id, holder, epk, ivB, ctB))))
  return { v: MAX_V, type: 'released', holder, id, epk, iv: ivB, ct: ctB, sig }
}

/**
 * A share holder: holds the signed shares dealt to `name`, and answers release requests from group members.
 *
 * @param {object} opts
 * @param {string} opts.name - the label this holder's shares were dealt under (usually its pod id)
 * @param {{ sign: Function, rawPublicKey: Function }} opts.identity - signs responses
 * @param {Uint8Array[]} opts.members - raw public keys of the current group members: the only requesters it answers
 * @param {Uint8Array[]} opts.trustedDealers - raw public keys of dealers whose shares it accepts
 * @param {() => number} [opts.now]
 * @param {number} [opts.freshnessMs=60000] - how far a request's `iat` may be from now, either way
 * @param {{ max: number, windowMs: number }} [opts.rate] - per requester key (default 10 per minute)
 * @param {number} [opts.maxInFlight=16] - requests being checked at once; more are `rate-limited`
 * @param {number} [opts.maxRequestBytes=4096]
 * @param {(info: { requester: string, agentId: string, groupId: string, epoch: number }) => boolean|Promise<boolean>} [opts.approve] - a last say before a share leaves (consent, a quorum, a person)
 * @param {(line: { outcome: 'released'|'refused', reason?: string, requester: string, tag: string, epoch?: number }) => void} [opts.log]
 */
export function createShareHolder({ name, identity, members, trustedDealers, now = Date.now, freshnessMs = DEFAULTS.freshnessMs, rate = DEFAULTS.rate, maxInFlight = DEFAULTS.maxInFlight, maxRequestBytes = DEFAULTS.maxRequestBytes, approve, log } = {}) {
  if (typeof name !== 'string' || name === '') throw bad('name must be a non-empty string')
  if (!identity || typeof identity.sign !== 'function') throw bad('identity (sign) is required')
  if (!Array.isArray(trustedDealers) || trustedDealers.length === 0) throw bad('trustedDealers must be a non-empty list of raw public keys')
  let roster = new Set()
  const setMembers = (list) => {
    if (!Array.isArray(list) || !list.every((k) => k instanceof Uint8Array && k.length === 32)) throw bad('members must be raw 32-byte Ed25519 public keys')
    roster = new Set(list.map(toB64))
  }
  setMembers(members ?? [])
  /** @type {Map<string, object[]>} tag -> shares (any epoch) */
  const byTag = new Map()
  /** @type {Map<string, number>} tag -> lowest epoch still accepted */
  const floors = new Map()
  const seen = new Map() // requester|nonce -> expiry
  const rates = new Map() // requester -> times
  let inFlight = 0
  const stats = { released: 0, refused: {} }

  const refuse = async (reason, request, extra = {}) => {
    stats.refused[reason] = (stats.refused[reason] ?? 0) + 1
    if (log) {
      let requester = ''
      try { requester = typeof request?.requester === 'string' ? await podIdOf(fromB64(request.requester)) : '' } catch { /* unreadable key */ }
      try { log({ outcome: 'refused', reason, requester, tag: typeof request?.tag === 'string' ? request.tag.slice(0, 8) : '' }) } catch { /* a hook never changes the outcome */ }
    }
    return { v: MAX_V, type: 'refused', holder: name, reason, ...extra }
  }

  return {
    name,
    setMembers,
    get stats() { return { released: stats.released, refused: { ...stats.refused } } },

    /** Accept a dealt share for this holder: it must verify against a trusted dealer, be dealt to this name, and not be older than the floor. */
    async addShare(share) {
      const v = await verifyStealthShare(share, { trustedDealers, agentId: share?.agentId, groupId: share?.groupId }).catch(() => ({ ok: false, reason: 'malformed' }))
      if (!v.ok) return v
      if (share.holder !== name) return { ok: false, reason: 'unknown-holder' }
      const tag = await stealthReleaseTag({ groupId: share.groupId, agentId: share.agentId })
      if (share.epoch < (floors.get(tag) ?? 0)) return { ok: false, reason: 'stale-epoch' }
      const list = (byTag.get(tag) ?? []).filter((s) => s.epoch !== share.epoch)
      list.push(share)
      byTag.set(tag, list)
      return { ok: true }
    },

    /** Drop this agent's shares of an epoch below `belowEpoch` and refuse any later. */
    async retire({ agentId, groupId, belowEpoch }) {
      const tag = await stealthReleaseTag({ groupId, agentId })
      floors.set(tag, Math.max(floors.get(tag) ?? 0, belowEpoch))
      byTag.set(tag, (byTag.get(tag) ?? []).filter((s) => s.epoch >= belowEpoch))
    },

    /**
     * The whole holder side. Never throws and never rejects: every outcome is a response object.
     * @param {string} fromPodId - the sender as the channel authenticated it (kept for the caller's accounting)
     * @param {object} request
     */
    async handle(fromPodId, request) {
      void fromPodId
      // 1. size and shape, before any work
      if (request === null || typeof request !== 'object' || Array.isArray(request)) return refuse('malformed', null)
      let size
      try { size = te.encode(JSON.stringify(request)).length } catch { return refuse('malformed', null) }
      if (size > maxRequestBytes) return refuse('too-large', null)
      if (!Number.isSafeInteger(request.v)) return refuse('malformed', null)
      if (request.v !== MAX_V) return refuse('unsupported-version', request, { maxV: MAX_V })
      const strings = ['type', 'tag', 'holder', 'requester', 'eph', 'nonce', 'sig']
      if (request.type !== 'release' || !strings.every((k) => typeof request[k] === 'string') || !Number.isSafeInteger(request.iat) || !Number.isSafeInteger(request.minEpoch) || request.minEpoch < 0) return refuse('malformed', null)
      // 2. addressed to this holder, and fresh
      if (request.holder !== name) return refuse('wrong-holder', request)
      const t = now()
      if (Math.abs(t - request.iat) > freshnessMs) return refuse('stale-request', request)
      // 3. rate, before signature work
      if (inFlight >= maxInFlight) return refuse('rate-limited', request)
      const times = (rates.get(request.requester) ?? []).filter((x) => t - x < rate.windowMs)
      const limited = times.length >= rate.max
      times.push(t)
      rates.set(request.requester, times)
      if (rates.size > 4096) for (const [k, ts] of rates) if (ts.every((x) => t - x >= rate.windowMs)) rates.delete(k)
      if (limited) return refuse('rate-limited', request)
      inFlight++
      try {
        // 4. the signature, then the replay cache
        let valid = false
        try {
          const key = await crypto.subtle.importKey('raw', fromB64(request.requester), { name: 'Ed25519' }, false, ['verify'])
          valid = await crypto.subtle.verify('Ed25519', key, fromB64(request.sig), requestSigningBytes(request))
        } catch { valid = false }
        if (!valid) return refuse('bad-signature', request)
        const replayKey = `${request.requester}|${request.nonce}`
        for (const [k, exp] of seen) if (exp <= t) seen.delete(k)
        if (seen.has(replayKey)) return refuse('replayed', request)
        seen.set(replayKey, t + 2 * freshnessMs)
        if (seen.size > DEFAULTS.replayCacheSize) seen.delete(seen.keys().next().value)
        // 5. membership: before the tag, so a non-member learns nothing about what is held
        if (!roster.has(request.requester)) return refuse('not-a-member', request)
        // 6. the tag
        const shares = byTag.get(request.tag)
        if (!shares || shares.length === 0) return refuse('no-share', request)
        // 7. epoch
        const floor = Math.max(request.minEpoch, floors.get(request.tag) ?? 0)
        const share = [...shares].sort((a, b) => b.epoch - a.epoch).find((s) => s.epoch >= floor)
        if (!share) return refuse('stale-epoch', request)
        // 8. the last say
        if (approve) {
          let ok = false
          try { ok = (await approve({ requester: await podIdOf(fromB64(request.requester)), agentId: share.agentId, groupId: share.groupId, epoch: share.epoch })) === true } catch { ok = false }
          if (!ok) return refuse('not-approved', request)
        }
        // 9. release, sealed to the requester
        const response = await createReleaseResponse({ request, share, identity, holder: name })
        stats.released++
        if (log) { try { log({ outcome: 'released', requester: await podIdOf(fromB64(request.requester)), tag: request.tag.slice(0, 8), epoch: share.epoch }) } catch { /* a hook never changes the outcome */ } }
        return response
      } catch {
        return refuse('malformed', request)
      } finally {
        inFlight--
      }
    },
  }
}

/**
 * Ask the holders for their shares and recombine the group secret.
 *
 * Sends one signed request per peer in parallel, verifies each answer (the holder's signature, the unsealed share against the
 * dealer, `minEpoch`, `holders`) and stops as soon as `t` distinct valid shares of one epoch are in. A peer that does not
 * answer within `timeoutMs`, or whose `send` fails (an older peer with no such channel), is `unreachable`. With fewer than `t`
 * valid shares it throws `StealthError` `below-threshold` carrying `details` and returns nothing.
 *
 * @param {object} p
 * @param {{ sign: Function, rawPublicKey: Function }} p.identity - the asking member
 * @param {string} p.agentId
 * @param {string} p.groupId
 * @param {Array<{ holder: string, publicKey: Uint8Array, send: (request: object) => Promise<object> }>} p.peers
 * @param {Uint8Array[]} p.trustedDealers
 * @param {number} [p.minEpoch=0]
 * @param {string[]} [p.holders] - current holders; a share dealt to anyone else is refused
 * @param {number} [p.timeoutMs=5000]
 * @returns {Promise<{ secret: Uint8Array, epoch: number, threshold: number, total: number, released: number, refused: { holder: string, reason: string }[], unreachable: string[] }>}
 */
export async function requestShareRelease({ identity, agentId, groupId, peers, trustedDealers, minEpoch = 0, holders, timeoutMs = DEFAULTS.timeoutMs, now = Date.now } = {}) {
  if (!Array.isArray(peers) || peers.length === 0 || peers.length > 255) throw bad('peers must be a list of 1 to 255 holders')
  if (!peers.every((p) => p && typeof p.holder === 'string' && p.publicKey instanceof Uint8Array && typeof p.send === 'function')) throw bad('every peer needs holder, publicKey and send')
  const verifyOpts = { trustedDealers, agentId, groupId, minEpoch, ...(holders ? { holders } : {}) }
  const valid = new Map() // epoch -> Map(index -> share)
  const refused = []
  const unreachable = []
  let released = 0
  let settle
  const done = new Promise((resolve) => { settle = resolve })
  const enough = () => { for (const set of valid.values()) { const [any] = set.values(); if (set.size >= any.threshold) return true } return false }
  let pending = peers.length

  const finish = () => { pending--; if (pending === 0 || enough()) settle() }
  const timers = []
  for (const peer of peers) {
    ;(async () => {
      try {
        const { request, open } = await createReleaseRequest({ identity, holder: peer.holder, holderKey: peer.publicKey, agentId, groupId, minEpoch, now })
        let timer
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); timers.push(timer) })
        let response
        try { response = await Promise.race([peer.send(request), timeout]) } catch { unreachable.push(peer.holder); return }
        finally { clearTimeout(timer) }
        const opened = await open(response)
        if (!opened.ok) { refused.push({ holder: peer.holder, reason: opened.reason }); return }
        const v = await verifyStealthShare(opened.share, verifyOpts)
        if (!v.ok) { refused.push({ holder: peer.holder, reason: v.reason }); return }
        const set = valid.get(opened.share.epoch) ?? valid.set(opened.share.epoch, new Map()).get(opened.share.epoch)
        set.set(opened.share.index, opened.share)
        released++
      } catch { refused.push({ holder: peer.holder, reason: 'bad-response' }) } finally { finish() }
    })()
  }
  await done
  for (const t of timers) clearTimeout(t)
  const shares = [...valid.values()].flatMap((m) => [...m.values()])
  try {
    const result = await reconstructStealthSecret(shares, verifyOpts)
    return { secret: result.secret, epoch: result.epoch, threshold: result.threshold, total: result.total, released, refused, unreachable }
  } catch (e) {
    if (e instanceof StealthError && e.code === 'below-threshold') throw Object.assign(new StealthError('below-threshold', `fewer than the threshold of valid shares were released (${released} valid, ${refused.length} refused, ${unreachable.length} unreachable)`), { details: { released, refused, unreachable } })
    throw e
  }
}
