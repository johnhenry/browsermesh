/**
 * Encode a Uint8Array as a base64url string (no padding).
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function encodeBase64url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decode a base64url string (no padding) to a Uint8Array.
 *
 * @param {string} str
 * @returns {Uint8Array}
 */
export function decodeBase64url(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** @type {boolean|null} Cached Ed25519 probe result; null until it resolves. */
let _ed25519Supported = null;

/** @type {Promise<boolean>|null} In-flight probe, so it runs at most once. */
let _ed25519Probe = null;

/**
 * Probe for WebCrypto Ed25519 support by asking for a key. Resolves true or
 * false, never throws, and caches the answer.
 *
 * This library has no software fallback for Ed25519, so a false here means the
 * whole identity layer is unavailable in this environment. WebCrypto Ed25519
 * shipped in **Safari 17** and **Chromium 137** — the latter is recent enough
 * that Android devices with an un-updated System WebView will not have it.
 * Call this before PodIdentity.generate() if you need to degrade gracefully
 * rather than catch a NotSupportedError from four frames down.
 *
 * @returns {Promise<boolean>}
 */
export function probeEd25519Support() {
  if (_ed25519Probe) return _ed25519Probe;
  _ed25519Probe = (async () => {
    if (typeof crypto === 'undefined' || !crypto.subtle ||
        typeof crypto.subtle.generateKey !== 'function') {
      return false;
    }
    try {
      await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
      return true;
    } catch {
      return false;
    }
  })().then((ok) => {
    _ed25519Supported = ok;
    return ok;
  });
  return _ed25519Probe;
}

/**
 * Cached answer from probeEd25519Support(), or null when the probe has not
 * resolved yet. Treat null as "unknown"; await probeEd25519Support() for a
 * definite answer.
 *
 * @returns {boolean|null}
 */
export function supportsEd25519() {
  if (_ed25519Supported === null) probeEd25519Support();
  return _ed25519Supported;
}

/** Reset the cached Ed25519 probe. Tests only. */
export function _resetEd25519Probe() {
  _ed25519Supported = null;
  _ed25519Probe = null;
}

/**
 * Derive a pod ID from an Ed25519 public key.
 * Pod ID = base64url(SHA-256(raw public key bytes)).
 *
 * @param {CryptoKey} publicKey - Ed25519 public key
 * @returns {Promise<string>} Base64url-encoded pod ID
 */
export async function derivePodId(publicKey) {
  const raw = await crypto.subtle.exportKey('raw', publicKey);
  const hash = await crypto.subtle.digest('SHA-256', raw);
  return encodeBase64url(new Uint8Array(hash));
}

/**
 * Represents a BrowserMesh pod identity (Ed25519 key pair).
 *
 * @class
 */
export class PodIdentity {
  /**
   * @param {object} opts
   * @param {CryptoKeyPair} opts.keyPair - Ed25519 key pair
   * @param {string} opts.podId - Base64url-encoded public key hash
   */
  constructor({ keyPair, podId }) {
    /** @type {CryptoKeyPair} */
    this.keyPair = keyPair;
    /** @type {string} */
    this.podId = podId;
  }

  /**
   * Generate a new PodIdentity with a fresh Ed25519 key pair.
   *
   * Requires WebCrypto Ed25519 (Safari 17+, Chromium 137+). There is no
   * software fallback: where the algorithm is missing this throws with a
   * message naming the requirement rather than a bare NotSupportedError.
   * Use probeEd25519Support() to check first.
   *
   * @returns {Promise<PodIdentity>}
   */
  static async generate() {
    let keyPair;
    try {
      keyPair = await crypto.subtle.generateKey(
        { name: 'Ed25519' },
        true, // extractable
        ['sign', 'verify']
      );
    } catch (err) {
      throw new Error(
        'WebCrypto Ed25519 is unavailable in this environment, and this library ' +
        'has no software fallback. Ed25519 requires Safari 17+ or Chromium 137+ ' +
        '(including the Android System WebView). Original error: ' +
        (err && err.message ? err.message : String(err)),
        { cause: err }
      );
    }
    const podId = await derivePodId(keyPair.publicKey);
    return new PodIdentity({ keyPair, podId });
  }

  /**
   * Sign data with this identity's private key.
   *
   * @param {BufferSource} data - Data to sign
   * @returns {Promise<Uint8Array>} Ed25519 signature
   */
  async sign(data) {
    return new Uint8Array(
      await crypto.subtle.sign('Ed25519', this.keyPair.privateKey, data)
    );
  }

  /**
   * Verify a signature against a public key.
   *
   * @param {CryptoKey} publicKey - Ed25519 public key
   * @param {BufferSource} data - Original data
   * @param {BufferSource} signature - Signature to verify
   * @returns {Promise<boolean>}
   */
  static async verify(publicKey, data, signature) {
    return crypto.subtle.verify('Ed25519', publicKey, signature, data);
  }
}
