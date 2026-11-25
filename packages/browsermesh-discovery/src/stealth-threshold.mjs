/**
 * stealth-threshold.mjs -- threshold sharing of the StealthAgent group secret (#328).
 *
 * Off by default and separate from `StealthAgent`: nothing here changes a shard record, a DHT key or
 * the sealed envelope. A dealer (the agent's owner pod, the identity that already signs its shards)
 * generates a 32-byte group secret `K`, splits it `t`-of-`n` with Shamir secret sharing over GF(2^8)
 * (the audited `shamir-secret-sharing` library, loaded on first use), signs every share with its
 * Ed25519 identity and hands each to a holder over a channel the caller already trusts. Any `t`
 * valid shares recombine `K`, which is then used exactly like a plain group secret
 * (`StealthKeyring#add`, `deriveStealthLookupNonce`; see `thresholdEpochKeys`).
 *
 * Design, threats, what a holder learns and what is NOT protected: docs/design/stealth-threshold.md.
 * In short: fewer than `t` shares reveal nothing about `K`; a dealer who is compromised, or `t`
 * colluding holders, reveal everything of that epoch; shares are signed, not encrypted, so they must
 * travel over confidential channels; a member who already read `K` keeps it, so leaving a group
 * means a new epoch (a new `K`), not a revoked share.
 */
import { StealthError, deriveStealthLookupNonce } from './stealth.mjs'

const SHARE_VERSION = 1
const SHARE_DOMAIN = 'browsermesh-stealth-threshold/1'
const KEYCHECK_DOMAIN = 'browsermesh-stealth-threshold/key-check/1'
const SECRET_BYTES = 32
const MAX_HOLDERS = 255
const NAME_RE = /^[^\u0000-\u001f\u007f]{1,256}$/u
const EPOCH_KEY_PREFIX = 'e'

let shamir = null
/** The Shamir library is loaded when first needed, so a page that never shares a key loads none of it. */
async function sss() {
  shamir ??= await import('shamir-secret-sharing')
  return shamir
}

const te = new TextEncoder()

const toBase64Url = (bytes) => {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
const B64U_RE = /^[A-Za-z0-9_-]*$/
function fromBase64Url(str) {
  if (typeof str !== 'string' || !B64U_RE.test(str) || str.length % 4 === 1) throw new TypeError('not base64url')
  const bin = atob(str.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (str.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
const u32 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])

/** Length-prefixed concatenation: no two different field lists encode to the same bytes. */
function frame(...parts) {
  const chunks = parts.map((p) => (typeof p === 'string' ? te.encode(p) : p))
  const out = new Uint8Array(chunks.reduce((n, c) => n + 4 + c.length, 0))
  let at = 0
  for (const c of chunks) { out.set(u32(c.length), at); at += 4; out.set(c, at); at += c.length }
  return out
}

const bad = (message) => new StealthError('bad-argument', message)

function checkName(value, what) {
  if (typeof value !== 'string' || !NAME_RE.test(value)) throw bad(`${what} must be a non-empty string without control characters`)
}
function checkEpoch(epoch, what = 'epoch') {
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw bad(`${what} must be a non-negative integer`)
}

async function keyCheckOf(secret, agentId, groupId, epoch) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', frame(KEYCHECK_DOMAIN, agentId, groupId, String(epoch), secret))))
}

/**
 * The bytes a dealer signs for one share: every field but `sig`, domain-separated and length-prefixed.
 * Exported so that a verifier on another platform (or a test) can build them.
 * @param {object} share
 * @returns {Uint8Array}
 */
export function stealthShareSigningBytes(share) {
  return frame(
    SHARE_DOMAIN, String(share.v), share.agentId, share.groupId, String(share.epoch), String(share.threshold), String(share.total),
    String(share.index), share.holder, share.keyCheck, share.share, share.dealer,
  )
}

/** The key id `thresholdEpochKeys` uses in a `StealthKeyring` for an epoch. */
export function stealthEpochKeyId(epoch) {
  checkEpoch(epoch)
  return `${EPOCH_KEY_PREFIX}${epoch}`
}

/**
 * Deal a fresh group secret: split it `threshold`-of-`holders.length` and sign each share.
 *
 * The dealer sees the secret (that is the dealer model); the returned `secret` is for the dealer to use
 * (`thresholdEpochKeys`) and then overwrite (`fill(0)`). Each `shares[i].share` goes to `holders[i]`
 * over a channel that is authenticated and confidential; the share is signed, not encrypted.
 *
 * @param {object} opts
 * @param {{ sign(bytes: Uint8Array): Promise<ArrayBuffer|Uint8Array>, rawPublicKey(): Promise<ArrayBuffer|Uint8Array> }} opts.identity - the dealer's Ed25519 identity
 * @param {string} opts.agentId
 * @param {string} opts.groupId
 * @param {number} [opts.epoch=0] - the epoch this secret belongs to; one more than the last when a member leaves
 * @param {string[]} opts.holders - one name per share (group members by default, or custodians): 2 to 255 distinct names
 * @param {number} [opts.threshold] - shares needed, 2..n; default a majority, `floor(n / 2) + 1`
 * @returns {Promise<{ secret: Uint8Array, epoch: number, threshold: number, total: number, shares: { holder: string, share: object }[] }>}
 */
export async function dealStealthShares({ identity, agentId, groupId, epoch = 0, holders, threshold } = {}) {
  if (!identity || typeof identity.sign !== 'function' || typeof identity.rawPublicKey !== 'function') throw bad('identity (sign, rawPublicKey) is required: the dealer signs every share')
  checkName(agentId, 'agentId')
  checkName(groupId, 'groupId')
  checkEpoch(epoch)
  if (!Array.isArray(holders) || holders.length < 2 || holders.length > MAX_HOLDERS) throw bad(`holders must be a list of 2 to ${MAX_HOLDERS} names`)
  for (const h of holders) checkName(h, 'a holder name')
  if (new Set(holders).size !== holders.length) throw bad('holders must be distinct')
  const total = holders.length
  const t = threshold ?? Math.floor(total / 2) + 1
  if (!Number.isInteger(t) || t < 2 || t > total) throw bad(`threshold must be a whole number from 2 to ${total} (1 would be the plain secret)`)

  const secret = crypto.getRandomValues(new Uint8Array(SECRET_BYTES))
  const dealer = toBase64Url(new Uint8Array(await identity.rawPublicKey()))
  const keyCheck = await keyCheckOf(secret, agentId, groupId, epoch)
  const { split } = await sss()
  const raw = await split(secret, total, t)
  const shares = []
  for (let i = 0; i < total; i++) {
    const bytes = raw[i]
    const share = { v: SHARE_VERSION, agentId, groupId, epoch, threshold: t, total, index: bytes[bytes.length - 1], holder: holders[i], keyCheck, share: toBase64Url(bytes), dealer }
    share.sig = toBase64Url(new Uint8Array(await identity.sign(stealthShareSigningBytes(share))))
    shares.push({ holder: holders[i], share })
  }
  return { secret, epoch, threshold: t, total, shares }
}

const imported = new Map()
async function verifyKey(raw) {
  const id = toBase64Url(raw)
  let key = imported.get(id)
  if (!key) {
    key = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify'])
    if (imported.size >= 256) imported.clear()
    imported.set(id, key)
  }
  return key
}

function checkTrusted(trustedDealers) {
  if (!Array.isArray(trustedDealers) || trustedDealers.length === 0 || !trustedDealers.every((k) => k instanceof Uint8Array && k.length === 32)) {
    throw bad('trustedDealers must be a non-empty list of raw 32-byte Ed25519 public keys: a share is accepted only from a dealer the reader names')
  }
}

/**
 * Check one share without using it. Never throws on a bad share: it says why.
 *
 * `reason` is one of `malformed`, `wrong-agent`, `wrong-group`, `untrusted-dealer`, `bad-signature`,
 * `bad-index`, `stale-epoch`, `unknown-holder`.
 *
 * @param {object} share
 * @param {object} opts
 * @param {Uint8Array[]} opts.trustedDealers - raw public keys of the dealers this reader accepts (the share's own `dealer` is only a claim)
 * @param {string} opts.agentId
 * @param {string} opts.groupId
 * @param {number} [opts.minEpoch=0] - shares of an earlier epoch are refused
 * @param {string[]} [opts.holders] - when given, a share dealt to anyone else is refused (current members)
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
export async function verifyStealthShare(share, { trustedDealers, agentId, groupId, minEpoch = 0, holders } = {}) {
  checkTrusted(trustedDealers)
  checkName(agentId, 'agentId')
  checkName(groupId, 'groupId')
  checkEpoch(minEpoch, 'minEpoch')
  if (holders !== undefined && (!Array.isArray(holders) || !holders.every((h) => typeof h === 'string'))) throw bad('holders must be a list of names')
  const no = (reason) => ({ ok: false, reason })
  if (share === null || typeof share !== 'object' || Array.isArray(share) || share.v !== SHARE_VERSION) return no('malformed')
  const { epoch, threshold, total, index } = share
  if (typeof share.agentId !== 'string' || typeof share.groupId !== 'string' || typeof share.holder !== 'string' || typeof share.keyCheck !== 'string'
    || typeof share.share !== 'string' || typeof share.dealer !== 'string' || typeof share.sig !== 'string'
    || !Number.isSafeInteger(epoch) || epoch < 0 || !Number.isInteger(threshold) || !Number.isInteger(total) || !Number.isInteger(index)
    || threshold < 2 || threshold > total || total > MAX_HOLDERS || index < 1 || index > 255) return no('malformed')
  let bytes
  let dealerKey
  let sig
  try { bytes = fromBase64Url(share.share); dealerKey = fromBase64Url(share.dealer); sig = fromBase64Url(share.sig) } catch { return no('malformed') }
  if (bytes.length !== SECRET_BYTES + 1 || dealerKey.length !== 32 || sig.length !== 64) return no('malformed')
  if (share.agentId !== agentId) return no('wrong-agent')
  if (share.groupId !== groupId) return no('wrong-group')
  if (!trustedDealers.some((k) => k.every((b, i) => b === dealerKey[i]))) return no('untrusted-dealer')
  let valid = false
  try { valid = await crypto.subtle.verify('Ed25519', await verifyKey(dealerKey), sig, stealthShareSigningBytes(share)) } catch { valid = false }
  if (!valid) return no('bad-signature')
  if (bytes[SECRET_BYTES] !== index) return no('bad-index')
  if (epoch < minEpoch) return no('stale-epoch')
  if (holders !== undefined && !holders.includes(share.holder)) return no('unknown-holder')
  return { ok: true }
}

/**
 * Recombine the group secret from signed shares.
 *
 * Each share is verified first (see `verifyStealthShare`); a share that does not verify is refused, counted in
 * `refused` and never used. The newest epoch with at least `threshold` distinct valid shares is used (epochs are
 * never mixed); exactly `threshold` of them are combined and the result is checked against the dealer-signed key
 * check. Throws `StealthError`: `below-threshold` (nothing is returned: too few valid shares), `key-check-failed`
 * (the shares were each signed but are not of one secret), `bad-argument`.
 *
 * @param {object[]} shares - signed shares (`dealStealthShares(...).shares[i].share`), from any holders
 * @param {object} opts - as `verifyStealthShare`
 * @returns {Promise<{ secret: Uint8Array, epoch: number, threshold: number, total: number, used: number[], refused: { index?: number, reason: string }[] }>}
 */
export async function reconstructStealthSecret(shares, opts = {}) {
  if (!Array.isArray(shares)) throw bad('shares must be a list')
  checkTrusted(opts.trustedDealers)
  const refused = []
  const byEpoch = new Map() // epoch -> Map(index -> share)
  for (const share of shares) {
    const result = await verifyStealthShare(share, opts)
    const index = Number.isInteger(share?.index) ? share.index : undefined
    if (!result.ok) { refused.push({ ...(index === undefined ? {} : { index }), reason: result.reason }); continue }
    const set = byEpoch.get(share.epoch) ?? byEpoch.set(share.epoch, new Map()).get(share.epoch)
    // Shares of one epoch must agree on how they were dealt, or they are not of one dealing.
    const first = set.values().next().value
    if (first && (first.threshold !== share.threshold || first.total !== share.total || first.keyCheck !== share.keyCheck)) { refused.push({ index, reason: 'inconsistent' }); continue }
    if (set.has(share.index)) { refused.push({ index, reason: 'duplicate' }); continue }
    set.set(share.index, share)
  }
  for (const epoch of [...byEpoch.keys()].sort((a, b) => b - a)) {
    const set = byEpoch.get(epoch)
    const [any] = set.values()
    if (set.size < any.threshold) continue
    const chosen = [...set.values()].sort((a, b) => a.index - b.index).slice(0, any.threshold)
    const { combine } = await sss()
    let secret
    try { secret = await combine(chosen.map((s) => fromBase64Url(s.share))) } catch { throw new StealthError('key-check-failed', 'the shares could not be combined') }
    if (secret.length !== SECRET_BYTES || await keyCheckOf(secret, any.agentId, any.groupId, epoch) !== any.keyCheck) {
      secret.fill(0)
      throw new StealthError('key-check-failed', `the ${any.threshold} shares of epoch ${epoch} are signed but do not recombine to the secret the dealer committed to`)
    }
    return { secret, epoch, threshold: any.threshold, total: any.total, used: chosen.map((s) => s.index), refused }
  }
  const counts = refused.length ? ` (${refused.length} refused: ${[...new Set(refused.map((r) => r.reason))].join(', ')})` : ''
  throw new StealthError('below-threshold', `fewer than the threshold of valid shares of one epoch${counts}`)
}

/**
 * Put a recombined secret to use: add it to `keyring` under the key id `e<epoch>` (made current) and return the
 * lookup nonce of that epoch, for `new StealthAgent({ keyring, lookupNonce })`. The earlier epoch's key stays in
 * the ring until `keyring.remove(stealthEpochKeyId(old))`, so the state sealed under it stays readable only while
 * the application keeps it.
 *
 * @param {Uint8Array} secret - 32 bytes from `dealStealthShares` or `reconstructStealthSecret`
 * @param {{ agentId: string, groupId: string, epoch: number, keyring: import('./stealth.mjs').StealthKeyring }} opts
 * @returns {Promise<{ keyId: string, lookupNonce: string }>}
 */
export async function thresholdEpochKeys(secret, { agentId, groupId, epoch, keyring } = {}) {
  if (!(secret instanceof Uint8Array) || secret.length !== SECRET_BYTES) throw bad(`secret must be ${SECRET_BYTES} bytes`)
  checkName(agentId, 'agentId')
  checkName(groupId, 'groupId')
  checkEpoch(epoch)
  if (!keyring || typeof keyring.add !== 'function') throw bad('keyring must be a StealthKeyring')
  const keyId = stealthEpochKeyId(epoch)
  await keyring.add(keyId, secret, { groupId, makeCurrent: true })
  return { keyId, lookupNonce: await deriveStealthLookupNonce(secret, agentId, epoch) }
}
