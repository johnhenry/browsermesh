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
// The certificate the connection actually uses
// ---------------------------------------------------------------------------

const DIGESTS = { 'sha-1': 'SHA-1', 'sha-256': 'SHA-256', 'sha-384': 'SHA-384', 'sha-512': 'SHA-512' }

/** @param {Uint8Array} bytes @returns {string} lower-case hex pairs separated by ':' */
function hexPairs(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(':')
}

/**
 * The fingerprint(s) of the certificate the remote end presented in the DTLS
 * handshake of `pc`, in the form `extractDtlsFingerprints` returns (so the
 * two can be compared), or `null` when the browser exposes none. Looks first
 * at `RTCDtlsTransport.getRemoteCertificates()` (hashing the leaf certificate
 * with each requested algorithm), then at the `certificate` entry of
 * `getStats()`. It never guesses: no source, no answer.
 *
 * @param {object} pc - an RTCPeerConnection
 * @param {string[]} [algorithms] - the hash names the description uses, e.g. `['sha-256']`
 * @returns {Promise<string[]|null>}
 */
export async function remoteCertificateFingerprints(pc, algorithms = ['sha-256']) {
  const wanted = [...new Set(algorithms.map((a) => String(a).toLowerCase()).filter((a) => DIGESTS[a]))]
  if (!wanted.length) return null
  try {
    const certs = pc?.sctp?.transport?.getRemoteCertificates?.()
    const der = certs?.length ? (certs[0] instanceof ArrayBuffer ? new Uint8Array(certs[0]) : certs[0]) : null
    // An empty buffer is a stub (some Node bindings return one), not a certificate.
    if (der?.byteLength > 0) {
      const out = []
      for (const alg of wanted) out.push(`${alg} ${hexPairs(new Uint8Array(await crypto.subtle.digest(DIGESTS[alg], der)))}`)
      return out.sort()
    }
  } catch { /* fall through to stats */ }
  try {
    const stats = await pc?.getStats?.()
    if (stats && typeof stats.forEach === 'function') {
      const byId = new Map()
      stats.forEach((v, k) => byId.set(k, v))
      let remoteId
      for (const v of byId.values()) if (v?.type === 'transport' && v.remoteCertificateId) remoteId = v.remoteCertificateId
      const c = remoteId ? byId.get(remoteId) : undefined
      if (c && typeof c.fingerprint === 'string' && /^[0-9A-Fa-f]{2}(:?[0-9A-Fa-f]{2})*$/.test(c.fingerprint)) {
        const alg = String(c.fingerprintAlgorithm || 'sha-256').toLowerCase()
        const hex = c.fingerprint.replace(/:/g, '').toLowerCase()
        return [`${alg} ${hex.match(/../g).join(':')}`]
      }
    }
  } catch { /* unavailable */ }
  return null
}

/**
 * True when the certificate seen in use is one the peer's description names:
 * something was compared, and every fingerprint seen is in the signed set.
 *
 * @param {string[]} expected - `extractDtlsFingerprints(peerSdp)`
 * @param {string[]} seen - `remoteCertificateFingerprints(pc, ...)`
 * @returns {boolean}
 */
export function certificateMatches(expected, seen) {
  if (!expected?.length || !seen?.length) return false
  return seen.every((s) => expected.includes(s))
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
