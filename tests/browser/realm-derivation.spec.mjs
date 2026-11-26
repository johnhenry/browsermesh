import { test, expect } from './fixtures.mjs'

// Realms (docs/design/realms.md, 5.10): one identity per realm, derived from one seed. This is the check the design
// note makes the first stage-2 task: can a page derive an Ed25519 key from a seed under WebCrypto, in every browser we
// ship to, and do they all derive the SAME key?
//
//   seed (32 bytes) --HKDF-SHA-256, info = DOMAIN + ' identity ' + realmId--> 32 bytes --PKCS#8--> Ed25519 private key
//
// The public key has to be read through an EXTRACTABLE import first: a non-extractable key cannot give it up. The key that
// is kept is the non-extractable one. The expected values were produced by Node 26's WebCrypto and are pinned here as the
// first test vector; Ed25519 signatures are deterministic, so the signature is pinned too.

const SEED_HEX = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0')).join('') // 00 01 .. 1f
const REALM_ID = 'realm-test-vector-0000000000000000000000000' // fixed text, not a real realm id
const DOMAIN = 'browsermesh/realm/v1'

const VECTOR = {
  derivedSeedHex: '0da1010425a78f9783e802c9109d3899cdb281f4a1cd5079cec7878a0a8d1235',
  publicKeyX: 'iAZS2VHtgLy47Huzd17k93TsC8HDwmHZCJNJhX7Ejng',
  signatureHex: 'cd3879ce06ce5d6cc9089851c6cf309519ec4bf6bcb1ea41eb00d89e8a03490eeb3e01f185fa8f966d96dcfdab12ab9aeff56f7b91288849416ce199d036500d',
}

test('realm identity: HKDF from a seed to a non-extractable Ed25519 key matches the pinned vector in this browser', async ({ servers, open }) => {
  const page = await open(servers.a, { isolated: true })
  const got = await page.evaluate(async ([seedHex, realmId, domain]) => {
    const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('')
    const seed = Uint8Array.from(seedHex.match(/../g).map((h) => parseInt(h, 16)))
    const out = { isSecureContext: globalThis.isSecureContext }
    const base = await crypto.subtle.importKey('raw', seed, 'HKDF', false, ['deriveBits'])
    const bits = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(`${domain} identity ${realmId}`) }, base, 256))
    const pkcs8 = new Uint8Array(48)
    pkcs8.set([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20])
    pkcs8.set(bits, 16)
    const probe = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign'])
    const jwk = await crypto.subtle.exportKey('jwk', probe)
    const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign'])
    out.keyExtractable = key.extractable
    try { await crypto.subtle.exportKey('pkcs8', key); out.exportRefused = false } catch { out.exportRefused = true }
    const msg = new TextEncoder().encode('realm exchange')
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, msg))
    const pub = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, { name: 'Ed25519' }, true, ['verify'])
    out.verifies = await crypto.subtle.verify({ name: 'Ed25519' }, pub, sig, msg)
    out.derivedSeedHex = hex(bits)
    out.publicKeyX = jwk.x
    out.signatureHex = hex(sig)
    return out
  }, [SEED_HEX, REALM_ID, DOMAIN])

  expect(got.isSecureContext).toBe(true)
  expect(got.keyExtractable).toBe(false)
  expect(got.exportRefused).toBe(true)
  expect(got.verifies).toBe(true)
  expect(got.derivedSeedHex).toBe(VECTOR.derivedSeedHex)
  expect(got.publicKeyX).toBe(VECTOR.publicKeyX)
  expect(got.signatureHex).toBe(VECTOR.signatureHex)
})
