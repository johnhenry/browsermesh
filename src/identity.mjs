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
   * @returns {Promise<PodIdentity>}
   */
  static async generate() {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'Ed25519' },
      true, // extractable
      ['sign', 'verify']
    );
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
