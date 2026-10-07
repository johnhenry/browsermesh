// Guards for the Ed25519 verify argument order.
//
// The canonical order everywhere in BrowserMesh is (identity, signature, data):
//   verify(publicKey, signature, data)
//   verify(signerPodId, signature, data)
//
// Library entry points throw a TypeError when they see a 64-byte signature
// where the identity belongs. Caller-supplied callbacks are different: the
// library hands THEM the arguments, and callers of callbacks usually catch, so
// an old-order callback just returns false. `guardVerifyFn` probes a callback
// once with a known-good vector to turn that silent failure into a TypeError.

/** Ed25519 signatures are exactly this many bytes. */
export const ED25519_SIGNATURE_BYTES = 64

/** `err.code` of every TypeError raised by this module. Catch blocks rethrow it. */
export const VERIFY_ORDER_ERROR_CODE = 'ERR_VERIFY_ARG_ORDER'

// RFC 8032 section 7.1, TEST 2 (1-byte message 0x72).
const VECTOR_PUBLIC_KEY = hex('3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c')
const VECTOR_MESSAGE = hex('72')
const VECTOR_SIGNATURE = hex(
  '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da' +
  '085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00',
)

function hex(s) {
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16)
  return out
}

function orderError(message) {
  const err = new TypeError(message)
  err.code = VERIFY_ORDER_ERROR_CODE
  return err
}

/** @param {unknown} err */
export function isVerifyOrderError(err) {
  return err instanceof TypeError && err.code === VERIFY_ORDER_ERROR_CODE
}

/** @param {unknown} v */
function isSignatureSized(v) {
  return (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) && v.byteLength === ED25519_SIGNATURE_BYTES
}

/**
 * Throw a TypeError when the identity argument is a 64-byte signature, i.e.
 * the caller used the pre-canonical `(signature, data, identity)` order.
 *
 * @param {unknown} identity - what should be a public key or signer pod ID
 * @param {string} label - e.g. 'identity.verify'
 */
export function assertIdentityFirst(identity, label) {
  if (isSignatureSized(identity)) {
    throw orderError(
      `${label}: argument order is (signerPodId, signature, data); ` +
      'the first argument is a 64-byte signature, which looks like the old (signature, data, signerPodId) order',
    )
  }
}

/** Dev mode unless NODE_ENV is explicitly 'production'. */
function devMode() {
  try {
    return globalThis.process?.env?.NODE_ENV !== 'production'
  } catch {
    return true
  }
}

/**
 * Probe `verifyFn` with a known-good Ed25519 vector in the canonical order
 * `(publicKey, signature, data)`. If it rejects that but accepts the OLD order
 * `(publicKey, data, signature)`, it is an old-order callback: throw.
 *
 * A callback that accepts the canonical order, rejects both (for instance it
 * resolves keys from a directory the vector is not in), or throws on the
 * probe passes: only a provable old-order callback is an error.
 *
 * @param {Function} verifyFn
 * @param {string} label
 * @returns {Promise<void>}
 */
export async function selfTestVerifyFn(verifyFn, label) {
  const attempt = async (...args) => {
    try {
      return (await verifyFn(...args)) === true
    } catch {
      return false
    }
  }
  if (await attempt(VECTOR_PUBLIC_KEY.slice(), VECTOR_SIGNATURE.slice(), VECTOR_MESSAGE.slice())) return
  if (await attempt(VECTOR_PUBLIC_KEY.slice(), VECTOR_MESSAGE.slice(), VECTOR_SIGNATURE.slice())) {
    throw orderError(
      `${label}: verifyFn uses the old argument order. It must now be ` +
      '(publicKey, signature, data), the same as crypto.subtle.verify; ' +
      'it accepted (publicKey, data, signature) for a known-good vector and rejected the new order',
    )
  }
}

/**
 * Wrap a caller-supplied `verifyFn` so the first use runs the one-time order
 * self-test (kicked off now, awaited before the first real call). The probe
 * result is sticky: once an old-order callback is detected every call rejects
 * with the same TypeError. Skipped when NODE_ENV is 'production'.
 *
 * Callers that catch errors around the wrapped function must rethrow when
 * `isVerifyOrderError(err)` is true.
 *
 * @template {Function|null|undefined} F
 * @param {F} verifyFn
 * @param {string} label
 * @returns {F}
 */
export function guardVerifyFn(verifyFn, label) {
  if (typeof verifyFn !== 'function' || !devMode()) return verifyFn
  const probe = selfTestVerifyFn(verifyFn, label)
  probe.catch(() => {}) // surfaced on first use, never as an unhandled rejection
  const guarded = async (...args) => {
    await probe
    return verifyFn(...args)
  }
  return /** @type {F} */ (guarded)
}

/**
 * Same as {@link guardVerifyFn} for an object exposing `verify(publicKey,
 * signature, data)` (a wallet). Returns a function to call instead of
 * `obj.verify(...)`. The probe is created lazily, once per object.
 *
 * @param {{ verify: Function }} obj
 * @param {string} label
 * @returns {(...args: any[]) => Promise<any>}
 */
export function guardVerifyMethod(obj, label) {
  let probe = null
  return async (...args) => {
    if (probe === null) {
      probe = devMode() ? selfTestVerifyFn((...a) => obj.verify(...a), label) : Promise.resolve()
      probe.catch(() => {})
    }
    await probe
    return obj.verify(...args)
  }
}
