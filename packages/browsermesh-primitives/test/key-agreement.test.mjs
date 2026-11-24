import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  PodIdentity, MemoryRevocationStore, retireIdentity, receiveRevocation,
  generateAgreementKeyPair, createKeyStatement, verifyKeyStatement, sealToStatement, openSealed,
  KeyAgreementError, MAX_STATEMENT_LIFETIME_MS,
} from '../src/index.mjs'

const enc = new TextEncoder()
const dec = new TextDecoder()
const NOW = 1_800_000_000_000
const HOUR = 3_600_000

async function recipient({ lifetimeMs = HOUR, now = NOW } = {}) {
  const identity = await PodIdentity.generate()
  const agreement = await generateAgreementKeyPair()
  const statement = await createKeyStatement(identity, agreement, { now, lifetimeMs })
  return { identity, agreement, statement }
}
const code = (p) => p.then(() => null, (e) => e.code)
const flip = (b64) => (b64[0] === 'A' ? 'B' : 'A') + b64.slice(1)

describe('key statements bind an agreement key to a pod id', () => {
  it('a statement signed by the identity key verifies, and says whose key and until when', async () => {
    const { identity, agreement, statement } = await recipient()
    const v = await verifyKeyStatement(statement, { now: NOW + 1000, expectedPodId: identity.podId })
    assert.equal(v.podId, identity.podId)
    assert.deepEqual([...v.ka], [...agreement.publicKeyRaw])
    assert.equal(v.notAfter, NOW + HOUR)
    assert.match(v.kid, /^[A-Za-z0-9_-]{22}$/)
  })

  it('a statement whose key is not the pod id it names is refused', async () => {
    const a = await recipient()
    const other = await PodIdentity.generate()
    assert.equal(await code(verifyKeyStatement({ ...a.statement, podId: other.podId }, { now: NOW })), 'pod-id-mismatch')
  })

  it('a statement not signed by the pod id\'s key is refused (a statement of another identity naming this pod id, or one with another key put in)', async () => {
    const victim = await recipient()
    const other = await PodIdentity.generate()
    const otherKey = await generateAgreementKeyPair()
    // Another identity signs its own key but names this pod id.
    const forged = await createKeyStatement(other, otherKey, { now: NOW })
    assert.equal(await code(verifyKeyStatement({ ...forged, podId: victim.identity.podId }, { now: NOW })), 'pod-id-mismatch')
    // Or the signed statement is kept and the agreement key changed.
    assert.equal(await code(verifyKeyStatement({ ...victim.statement, ka: (await generateAgreementKeyPair()).publicKeyRaw && flip(victim.statement.ka) }, { now: NOW })), 'bad-signature')
    // Or alters the expiry.
    assert.equal(await code(verifyKeyStatement({ ...victim.statement, notAfter: victim.statement.notAfter + HOUR }, { now: NOW })), 'bad-signature')
  })

  it('an expired statement is refused, and one that is not valid yet', async () => {
    const { statement } = await recipient()
    assert.equal(await code(verifyKeyStatement(statement, { now: NOW + HOUR })), 'expired')
    assert.equal(await code(verifyKeyStatement(statement, { now: NOW + HOUR + 5 * 60_000 })), 'expired')
    assert.equal(await code(verifyKeyStatement(statement, { now: NOW - 10 * 60_000 })), 'not-yet-valid')
    assert.equal(await code(verifyKeyStatement(statement, { now: NOW - 1000 })), null, 'small clock skew is tolerated')
  })

  it('a statement that lives longer than the maximum is refused', async () => {
    await assert.rejects(recipient({ lifetimeMs: MAX_STATEMENT_LIFETIME_MS + 1 }), { code: 'lifetime-too-long' })
    const { identity, agreement } = await recipient()
    const long = await createKeyStatement(identity, agreement, { now: NOW, lifetimeMs: MAX_STATEMENT_LIFETIME_MS })
    assert.equal(await code(verifyKeyStatement({ ...long, notAfter: long.notAfter + 1 }, { now: NOW })), 'lifetime-too-long')
  })

  it('a statement for a pod other than the one expected is refused', async () => {
    const { statement } = await recipient()
    assert.equal(await code(verifyKeyStatement(statement, { now: NOW, expectedPodId: 'someone-else' })), 'wrong-identity')
  })

  it('a retired identity\'s statements are refused, through the same revocation store as session certificates', async () => {
    const { identity, statement } = await recipient()
    const store = new MemoryRevocationStore({ clock: () => NOW })
    assert.equal(await code(verifyKeyStatement(statement, { now: NOW, revocations: store })), null)
    await receiveRevocation(await retireIdentity(identity, { now: NOW }), store)
    assert.equal(await code(verifyKeyStatement(statement, { now: NOW, revocations: store })), 'identity-retired')
  })

  it('malformed statements are refused without throwing anything but a KeyAgreementError', async () => {
    const { statement } = await recipient()
    for (const bad of [null, 5, {}, { ...statement, v: 2 }, { ...statement, ka: 'short' }, { ...statement, sig: 5 }, { ...statement, notAfter: 'x' }]) {
      const e = await verifyKeyStatement(bad, { now: NOW }).then(() => null, (x) => x)
      assert.ok(e instanceof KeyAgreementError, JSON.stringify(bad)?.slice(0, 40))
    }
  })
})

describe('sealing to a statement', () => {
  const aad = enc.encode('header-1')

  async function sealed(plaintext = 'the secret') {
    const r = await recipient()
    const v = await verifyKeyStatement(r.statement, { now: NOW })
    const box = await sealToStatement(v, { aad, plaintext: enc.encode(plaintext) })
    return { ...r, v, box, keys: new Map([[v.kid, r.agreement]]) }
  }

  it('the recipient opens it; the sealed form holds no plaintext', async () => {
    const s = await sealed('meet at dawn, private bytes')
    assert.equal(dec.decode(await openSealed(s.box, { privateKeys: s.keys, aad })), 'meet at dawn, private bytes')
    assert.ok(!JSON.stringify(s.box).includes('dawn'))
    assert.deepEqual(Object.keys(s.box).sort(), ['ct', 'epk', 'iv', 'kid', 'v'])
  })

  it('every seal is fresh: same plaintext, different ephemeral key, nonce and ciphertext', async () => {
    const r = await recipient()
    const v = await verifyKeyStatement(r.statement, { now: NOW })
    const seen = new Set()
    for (let i = 0; i < 50; i++) {
      const b = await sealToStatement(v, { aad, plaintext: enc.encode('same') })
      seen.add(b.epk); seen.add(b.iv); seen.add(b.ct)
    }
    assert.equal(seen.size, 150)
  })

  it('tampering with the ciphertext, nonce, ephemeral key or key id is refused', async () => {
    const s = await sealed()
    for (const field of ['ct', 'iv', 'epk']) {
      assert.equal(await code(openSealed({ ...s.box, [field]: flip(s.box[field]) }, { privateKeys: s.keys, aad })), 'open-failed', field)
    }
    assert.equal(await code(openSealed({ ...s.box, kid: 'AAAAAAAAAAAAAAAAAAAAAA' }, { privateKeys: s.keys, aad })), 'unknown-key')
    assert.equal(await code(openSealed({ ...s.box, v: 2 }, { privateKeys: s.keys, aad })), 'malformed')
  })

  it('a different header (associated data) is refused: the ciphertext cannot be moved to another message', async () => {
    const s = await sealed()
    assert.equal(await code(openSealed(s.box, { privateKeys: s.keys, aad: enc.encode('header-2') })), 'open-failed')
  })

  it('a pod holding another key cannot open it', async () => {
    const s = await sealed()
    const other = await recipient()
    const wrongKey = new Map([[s.v.kid, other.agreement]])
    assert.equal(await code(openSealed(s.box, { privateKeys: wrongKey, aad })), 'open-failed')
  })

  it('sizes are bounded on both sides', async () => {
    const r = await recipient()
    const v = await verifyKeyStatement(r.statement, { now: NOW })
    await assert.rejects(sealToStatement(v, { aad, plaintext: new Uint8Array(1001), maxBytes: 1000 }), { code: 'too-large' })
    const box = await sealToStatement(v, { aad, plaintext: new Uint8Array(1000), maxBytes: 1000 })
    const keys = new Map([[v.kid, r.agreement]])
    assert.equal(await code(openSealed(box, { privateKeys: keys, aad, maxBytes: 999 })), 'too-large')
    assert.equal(await code(openSealed({ ...box, ct: 'A'.repeat(4_000_000) }, { privateKeys: keys, aad })), 'too-large')
  })
})
