/**
 * realm/custody.mjs -- where the realm's signing keys live, and how they come out.
 *
 * A realm's ROOT key is its whole authority, so unlike `meshctl`'s own identity file (a plaintext JWK, mode 0600) the
 * root and any issuer key are SEALED with `@johnhenry/keyvault`: a self-describing record, AES-GCM under a key derived
 * from a passphrase, whose type, KDF parameters and header (`realm`, `role`, `publicKey`) are authenticated. The
 * payload is the key's PKCS#8 bytes.
 *
 * The passphrase is never taken from argv: only `--passphrase-env <VAR>` or `--passphrase-file <path>` (a file must
 * be readable by its owner alone). A key is unsealed only for the signing call that needs it, imported NON-EXTRACTABLE,
 * and the decrypted buffer is zeroed straight away. JavaScript cannot wipe a string or a CryptoKey, so this is best
 * effort: the passphrase string and the key object live until they are collected.
 */

import { constants } from 'node:fs'
import { open as openFile } from 'node:fs/promises'
import { seal, open, VaultError } from '@johnhenry/keyvault'
import { PodIdentity, encodeBase64url, decodeBase64url } from '@johnhenry/browsermesh-primitives'
import { RealmCliError, UsageError } from './errors.mjs'

export const KEY_TYPE = 'browsermesh-realm-root'

const HOW = 'use --passphrase-env <VAR> or --passphrase-file <path> (the passphrase is never taken from argv)'

/**
 * Read the passphrase from the one place it may come from.
 * @param {Record<string, *>} flags
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<string>}
 */
export async function readPassphrase(flags, env) {
  if ('passphrase' in flags) throw new UsageError(`--passphrase is not accepted: ${HOW}`)
  const envName = flags['passphrase-env']
  const file = flags['passphrase-file']
  if (envName !== undefined && file !== undefined) throw new UsageError('give --passphrase-env or --passphrase-file, not both')
  if (envName === undefined && file === undefined) throw new UsageError(`this command signs with a sealed key and needs its passphrase: ${HOW}`)

  if (envName !== undefined) {
    if (typeof envName !== 'string') throw new UsageError('--passphrase-env needs the NAME of an environment variable')
    const value = env[envName]
    if (typeof value !== 'string' || value.length === 0) throw new UsageError(`environment variable ${envName} is unset or empty`)
    return value
  }

  if (typeof file !== 'string') throw new UsageError('--passphrase-file needs a path')
  // ONE open, and every check and the read go through that descriptor, so the file cannot be swapped between the
  // check and the read. O_NOFOLLOW makes a symlink a refusal (where the platform has it; Windows has no such flag).
  let fh
  try {
    fh = await openFile(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (err) {
    if (err?.code === 'ENOENT') throw new RealmCliError('ENOENT', `passphrase file '${file}' does not exist`)
    if (err?.code === 'ELOOP' || err?.code === 'EMLINK') {
      throw new RealmCliError('EREALM_PASSPHRASE_FILE_MODE', `refusing passphrase file '${file}': it is a symlink (give the real path)`)
    }
    throw err
  }
  let passphrase
  try {
    const st = await fh.stat()
    if (!st.isFile()) throw new UsageError(`passphrase file '${file}' is not a regular file`)
    const foreign = typeof process.getuid === 'function' && st.uid !== process.getuid()
    if ((st.mode & 0o177) !== 0 || foreign) {
      throw new RealmCliError('EREALM_PASSPHRASE_FILE_MODE', `refusing passphrase file '${file}': it must belong to you and be mode 0600 (chmod 600), not ${(st.mode & 0o777).toString(8).padStart(3, '0')}`)
    }
    passphrase = (await fh.readFile('utf8')).replace(/\r?\n$/, '')
  } finally {
    await fh.close()
  }
  if (passphrase.length === 0) throw new UsageError(`passphrase file '${file}' is empty`)
  return passphrase
}

/**
 * A fresh Ed25519 key: the identity (to sign with now), its public key, and its PKCS#8 bytes (to seal, then zero).
 * @returns {Promise<{ identity: PodIdentity, publicKey: string, pkcs8: Uint8Array }>}
 */
export async function generateKey() {
  const identity = await PodIdentity.generate({ extractable: true })
  return {
    identity,
    publicKey: encodeBase64url(await identity.rawPublicKey()),
    pkcs8: await identity.exportPrivateKey('pkcs8'),
  }
}

/**
 * Seal a key. Zeroes `pkcs8` afterwards.
 * @param {{ pkcs8: Uint8Array, publicKey: string }} key
 * @param {{ realm: string, role: 'root' | 'issuer' }} header
 * @param {string} passphrase
 * @returns {Promise<string>} the sealed record (JSON text)
 */
export async function sealKey({ pkcs8, publicKey }, { realm, role }, passphrase) {
  try {
    return await seal(pkcs8, passphrase, { type: KEY_TYPE, header: { realm, role, publicKey } })
  } finally {
    pkcs8.fill(0)
  }
}

/** The public header of a sealed record (readable without the passphrase, authenticated by `open`), or null. */
export function sealedHeader(text) {
  try {
    const rec = JSON.parse(text)
    if (rec?.t !== KEY_TYPE || typeof rec.publicKey !== 'string') return null
    return { realm: rec.realm, role: rec.role, publicKey: rec.publicKey }
  } catch {
    return null
  }
}

/**
 * Unseal a key for one signing call. The result is a NON-extractable identity.
 * @param {string} text the sealed record
 * @param {string} passphrase
 * @param {{ realm: string, role: 'root' | 'issuer', publicKey: string }} expect what the descriptor says this key is
 * @returns {Promise<PodIdentity>}
 */
export async function unsealKey(text, passphrase, expect) {
  let opened
  try {
    opened = await open(text, passphrase, { type: KEY_TYPE })
  } catch (err) {
    if (err instanceof VaultError) {
      if (err.code === 'bad_passphrase') throw new RealmCliError('EREALM_BAD_PASSPHRASE', 'wrong passphrase (or the key file was modified)')
      if (err.code === 'weak_secret') throw new UsageError(`the passphrase is unusable: ${err.message}`)
      throw new RealmCliError('EREALM_CORRUPT', `the sealed ${expect.role} key cannot be read: ${err.message}`)
    }
    throw err
  }
  const { payload, header } = opened
  try {
    if (header.realm !== expect.realm || header.role !== expect.role || header.publicKey !== expect.publicKey) {
      throw new RealmCliError('EREALM_CORRUPT', `the sealed ${expect.role} key is not the one this realm's descriptor names`)
    }
    return await PodIdentity.fromPkcs8(payload, { extractable: false, publicKey: decodeBase64url(expect.publicKey) })
  } finally {
    payload.fill(0)
  }
}
