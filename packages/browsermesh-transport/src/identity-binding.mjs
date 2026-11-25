/**
 * identity-binding.mjs -- bind a WebRTC connection to the pod identities at
 * its two ends.
 *
 * Signalling (offer/answer through a relay or signalling server) tells each
 * side which pod it is talking to, but a server on that path can swap the
 * session descriptions and sit in the middle. The DTLS certificate
 * fingerprints in the two descriptions identify the certificates that will
 * actually secure the channel, so each side proves possession of its pod key
 * over *both* of them, on the data channel, before any application message is
 * accepted:
 *
 *   transcript = "browsermesh/webrtc-binding/v1\n" + canonical JSON of
 *     { offerer, answerer, offerFp, answerFp, signer }
 *
 * where `offerer`/`answerer` are the two pod ids, `offerFp`/`answerFp` the
 * sorted, normalised fingerprints of the offer and the answer, and `signer` is
 * `'offerer'` or `'answerer'` (so a proof made by one side cannot be reflected
 * back at it). Each side builds the transcript from the two descriptions *it*
 * applied. If a server changed either description in transit, the two sides
 * build different transcripts and neither proof verifies.
 *
 * The proof carries the signer's public key; the key must hash to the pod id
 * claimed for that peer (pod id = base64url(SHA-256(raw public key))).
 *
 * All functions here are pure apart from the signing call.
 *
 * Browser-safe: WebCrypto only.
 */

export const BINDING_DOMAIN = 'browsermesh/webrtc-binding/v1\n'

/** `type` of the proof frame sent on the control data channel. */
export const BINDING_FRAME_TYPE = 'mesh:bind'

const encoder = new TextEncoder()

/** @param {Uint8Array} bytes @returns {string} */
function toBase64url(bytes) {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** @param {string} str @returns {Uint8Array|null} */
function fromBase64url(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str) || str.length % 4 === 1) return null
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(str.length / 4) * 4, '='))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * The DTLS fingerprints named in an SDP, normalised (`"<algorithm> <hex bytes
 * separated by ':'>"`, lower case) and sorted, without duplicates. A bundled
 * description names one; several are all kept so that none can be swapped.
 *
 * @param {string} sdp
 * @returns {string[]}
 */
export function extractDtlsFingerprints(sdp) {
  if (typeof sdp !== 'string') return []
  const found = new Set()
  for (const line of sdp.split(/\r?\n/)) {
    const m = /^a=fingerprint:([A-Za-z0-9-]+)[ \t]+([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2})*)[ \t]*$/.exec(line)
    if (m) found.add(`${m[1].toLowerCase()} ${m[2].toLowerCase()}`)
  }
  return [...found].sort()
}

/**
 * Canonical JSON (sorted keys) of the strings, arrays of strings and plain
 * objects used by the transcript.
 * @param {*} v
 * @returns {string}
 */
function canonical(v) {
  if (typeof v === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  }
  throw new TypeError('unsupported value in transcript')
}

/**
 * The bytes a side signs.
 *
 * @param {object} p
 * @param {string} p.offererPodId
 * @param {string} p.answererPodId
 * @param {string[]} p.offerFingerprints - from `extractDtlsFingerprints(offerSdp)`
 * @param {string[]} p.answerFingerprints
 * @param {'offerer'|'answerer'} p.signer - which side is signing
 * @returns {Uint8Array}
 */
export function bindingTranscript({ offererPodId, answererPodId, offerFingerprints, answerFingerprints, signer }) {
  if (!offererPodId || !answererPodId || typeof offererPodId !== 'string' || typeof answererPodId !== 'string') {
    throw new TypeError('both pod ids are required')
  }
  if (!offerFingerprints?.length || !answerFingerprints?.length) {
    throw new TypeError('both descriptions must name a DTLS fingerprint')
  }
  if (signer !== 'offerer' && signer !== 'answerer') throw new TypeError('signer must be offerer or answerer')
  return encoder.encode(BINDING_DOMAIN + canonical({
    offerer: offererPodId,
    answerer: answererPodId,
    offerFp: [...offerFingerprints].sort(),
    answerFp: [...answerFingerprints].sort(),
    signer,
  }))
}

// ---------------------------------------------------------------------------
// Signed session descriptions: verified before they are applied
// ---------------------------------------------------------------------------
//
// The proof above is checked once the connection is up. A description the
// signalling path changed is applied first and found out later. Signing each
// description lets the receiver check it against the sender's key *before*
// it touches the RTCPeerConnection:
//
//   transcript = "browsermesh/webrtc-description/v1\n" + canonical JSON of
//     { kind, signer, peer, sdp, fp, [offer] }
//
// `kind` is `'offer'` or `'answer'`, `signer` the sender's pod id, `peer` the
// pod id it is addressed to (so a description cannot be re-addressed), `sdp`
// the hex SHA-256 of the exact text, `fp` its sorted DTLS fingerprints, and,
// for an answer, `offer` the hex SHA-256 of the offer it answers (so an
// answer cannot be moved onto another attempt). The signed value travels
// next to the description as `auth` = `{ v: 1, podId, pk, sig }`, an extra
// field an older peer ignores.
//
// Not covered: freshness. A recorded offer can be replayed to its addressee;
// it names ICE credentials and a certificate only its maker can complete, so
// the most that follows is an answer to a connection that cannot come up.

export const DESCRIPTION_DOMAIN = 'browsermesh/webrtc-description/v1\n'

/** @param {string} text @returns {Promise<string>} hex SHA-256 of the UTF-8 text */
async function sha256Hex(text) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * The bytes a sender signs over one description.
 *
 * @param {object} p
 * @param {'offer'|'answer'} p.kind
 * @param {string} p.signerPodId
 * @param {string} p.peerPodId - the pod the description is addressed to
 * @param {string} p.sdp
 * @param {string} [p.offerSdp] - required for an answer: the offer it answers
 * @returns {Promise<Uint8Array>}
 */
export async function descriptionTranscript({ kind, signerPodId, peerPodId, sdp, offerSdp }) {
  if (kind !== 'offer' && kind !== 'answer') throw new TypeError('kind must be offer or answer')
  if (!signerPodId || !peerPodId || typeof signerPodId !== 'string' || typeof peerPodId !== 'string') {
    throw new TypeError('both pod ids are required')
  }
  if (typeof sdp !== 'string' || !extractDtlsFingerprints(sdp).length) throw new TypeError('the description must name a DTLS fingerprint')
  if (kind === 'answer' && typeof offerSdp !== 'string') throw new TypeError('an answer must name the offer it answers')
  const body = { kind, signer: signerPodId, peer: peerPodId, sdp: await sha256Hex(sdp), fp: extractDtlsFingerprints(sdp) }
  if (kind === 'answer') body.offer = await sha256Hex(offerSdp)
  return encoder.encode(DESCRIPTION_DOMAIN + canonical(body))
}

/**
 * Sign a description this side produced.
 *
 * @param {{ podId: string, sign: Function, rawPublicKey: Function }} identity - a `PodIdentity`
 * @param {object} p
 * @param {'offer'|'answer'} p.kind
 * @param {string} p.peerPodId
 * @param {string} p.sdp
 * @param {string} [p.offerSdp]
 * @returns {Promise<{ v: 1, podId: string, pk: string, sig: string }>}
 */
export async function signDescription(identity, { kind, peerPodId, sdp, offerSdp }) {
  const bytes = await descriptionTranscript({ kind, signerPodId: identity.podId, peerPodId, sdp, offerSdp })
  const [raw, sig] = [await identity.rawPublicKey(), await identity.sign(bytes)]
  return { v: 1, podId: identity.podId, pk: toBase64url(raw), sig: toBase64url(new Uint8Array(sig)) }
}

/**
 * Verify a description received, against the key behind the pod id it was
 * expected from, before applying it.
 *
 * @param {*} auth - the `auth` field next to the description (may be absent)
 * @param {object} p
 * @param {'offer'|'answer'} p.kind
 * @param {string} p.expectedPodId - the pod the description must come from
 * @param {string} p.localPodId - this side (the addressee)
 * @param {string} p.sdp
 * @param {string} [p.offerSdp] - for an answer, the offer this side sent
 * @returns {Promise<{ ok: true } | { ok: false, reason: 'unsigned'|'malformed'|'wrong-pod-id'|'no-fingerprint'|'bad-signature' }>}
 */
export async function verifyDescription(auth, { kind, expectedPodId, localPodId, sdp, offerSdp }) {
  if (auth === undefined || auth === null) return { ok: false, reason: 'unsigned' }
  if (typeof auth !== 'object' || auth.v !== 1) return { ok: false, reason: 'malformed' }
  const raw = fromBase64url(auth.pk)
  const sig = fromBase64url(auth.sig)
  if (!raw || raw.length !== 32 || !sig || sig.length !== 64) return { ok: false, reason: 'malformed' }
  if ((await podIdOfRawKey(raw)) !== expectedPodId || auth.podId !== expectedPodId) return { ok: false, reason: 'wrong-pod-id' }
  let bytes
  try {
    bytes = await descriptionTranscript({ kind, signerPodId: expectedPodId, peerPodId: localPodId, sdp, offerSdp })
  } catch {
    return { ok: false, reason: typeof sdp === 'string' && !extractDtlsFingerprints(sdp).length ? 'no-fingerprint' : 'malformed' }
  }
  let valid = false
  try {
    const key = await crypto.subtle.importKey('raw', raw, 'Ed25519', false, ['verify'])
    valid = await crypto.subtle.verify('Ed25519', key, sig, bytes)
  } catch {
    valid = false
  }
  return valid ? { ok: true } : { ok: false, reason: 'bad-signature' }
}

/** @param {Uint8Array} raw @returns {Promise<string>} pod id */
export async function podIdOfRawKey(raw) {
  return toBase64url(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)))
}

/**
 * Build the proof this side sends.
 *
 * @param {{ podId: string, sign: (data: Uint8Array) => Promise<Uint8Array>, rawPublicKey: () => Promise<Uint8Array> }} identity - a `PodIdentity`
 * @param {Parameters<typeof bindingTranscript>[0]} transcript - `signer` is this side's role
 * @returns {Promise<{ type: 'mesh:bind', v: 1, podId: string, role: string, pk: string, sig: string }>}
 */
export async function createBindingProof(identity, transcript) {
  const bytes = bindingTranscript(transcript)
  const [raw, sig] = [await identity.rawPublicKey(), await identity.sign(bytes)]
  return {
    type: BINDING_FRAME_TYPE,
    v: 1,
    podId: identity.podId,
    role: transcript.signer,
    pk: toBase64url(raw),
    sig: toBase64url(new Uint8Array(sig)),
  }
}

/**
 * Verify the peer's proof against the descriptions this side applied.
 *
 * @param {*} proof - the frame received
 * @param {object} p
 * @param {string} p.expectedPodId - the pod id claimed for the peer in signalling
 * @param {'offerer'|'answerer'} p.peerRole - the role the peer has in this connection
 * @param {string} p.offererPodId
 * @param {string} p.answererPodId
 * @param {string[]} p.offerFingerprints
 * @param {string[]} p.answerFingerprints
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
export async function verifyBindingProof(proof, { expectedPodId, peerRole, offererPodId, answererPodId, offerFingerprints, answerFingerprints }) {
  if (!proof || typeof proof !== 'object' || proof.type !== BINDING_FRAME_TYPE || proof.v !== 1) {
    return { ok: false, reason: 'malformed' }
  }
  const raw = fromBase64url(proof.pk)
  const sig = fromBase64url(proof.sig)
  if (!raw || raw.length !== 32 || !sig || sig.length !== 64) return { ok: false, reason: 'malformed' }
  if (proof.role !== peerRole) return { ok: false, reason: 'wrong-role' }

  // The pod id claimed in signalling must be the hash of the key that signed.
  if ((await podIdOfRawKey(raw)) !== expectedPodId || proof.podId !== expectedPodId) {
    return { ok: false, reason: 'wrong-pod-id' }
  }

  let bytes
  try {
    bytes = bindingTranscript({ offererPodId, answererPodId, offerFingerprints, answerFingerprints, signer: peerRole })
  } catch {
    return { ok: false, reason: 'no-fingerprint' }
  }
  let valid = false
  try {
    const key = await crypto.subtle.importKey('raw', raw, 'Ed25519', false, ['verify'])
    valid = await crypto.subtle.verify('Ed25519', key, sig, bytes)
  } catch {
    valid = false
  }
  return valid ? { ok: true } : { ok: false, reason: 'bad-signature' }
}
