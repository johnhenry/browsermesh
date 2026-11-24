// Run with: node --import ./test/_setup-globals.mjs --test test/stealth-keyring.test.mjs
// #230: keyed, versioned, replay-bounded sealing for StealthAgent state (v2 envelope).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DhtNode, StealthAgent, StealthKeyring, StealthError,
  sealStealthMessage, openStealthMessage,
} from '../src/index.mjs'

const secretA = new Uint8Array(32).fill(1)
const secretB = new Uint8Array(32).fill(2)
const STATE = JSON.stringify({ memory: ['the launch code is 0000'], n: 42 })

async function ring(entries = [{ id: 'k1', secret: secretA }], current) {
  return StealthKeyring.fromGroupSecrets('group-a', entries, current)
}

async function reason(promise) {
  try { await promise } catch (e) { assert.ok(e instanceof StealthError, `got ${e}`); return e.code }
  assert.fail('expected a refusal')
}

function agent(keyring, dhtNode, extra = {}) {
  return new StealthAgent({
    agentId: 'agent-007',
    dhtNode: dhtNode ?? new DhtNode({ localId: 'n', sendFn: () => {} }),
    threshold: 3, totalShards: 5, keyring, ...extra,
  })
}

describe('stealth v2 envelope', () => {
  it('round-trips, is not plaintext, and names its key id', async () => {
    const kr = await ring()
    const sealed = await sealStealthMessage(STATE, { keyring: kr, sender: 'agent-007', type: 'state' })
    assert.ok(sealed.startsWith('v2.k1.'))
    assert.ok(!sealed.includes('launch'))
    const opened = await openStealthMessage(sealed, { keyring: kr, sender: 'agent-007', type: 'state' })
    assert.equal(opened.plaintext, STATE)
    assert.equal(opened.keyId, 'k1')
  })

  it('wrong key is refused', async () => {
    const sealed = await sealStealthMessage(STATE, { keyring: await ring(), sender: 's', type: 'state' })
    const other = await ring([{ id: 'k1', secret: secretB }])
    assert.equal(await reason(openStealthMessage(sealed, { keyring: other, sender: 's', type: 'state' })), 'tampered')
    const unknown = await ring([{ id: 'k9', secret: secretA }])
    assert.equal(await reason(openStealthMessage(sealed, { keyring: unknown, sender: 's', type: 'state' })), 'unknown-key')
  })

  it('tampered ciphertext is refused', async () => {
    const kr = await ring()
    const sealed = await sealStealthMessage(STATE, { keyring: kr, sender: 's', type: 'state' })
    const i = sealed.length - 3
    const bad = sealed.slice(0, i) + (sealed[i] === 'A' ? 'B' : 'A') + sealed.slice(i + 1)
    assert.equal(await reason(openStealthMessage(bad, { keyring: kr, sender: 's', type: 'state' })), 'tampered')
  })

  it('tampered associated data is refused: sender, type, and the header fields', async () => {
    const kr = await ring()
    const sealed = await sealStealthMessage(STATE, { keyring: kr, sender: 's', type: 'state', seq: 10, issuedAt: 1000 })
    assert.equal(await reason(openStealthMessage(sealed, { keyring: kr, sender: 't', type: 'state' })), 'tampered')
    assert.equal(await reason(openStealthMessage(sealed, { keyring: kr, sender: 's', type: 'announce' })), 'tampered')
    const parts = sealed.split('.')
    for (const [idx, v] of [[2, '11'], [3, '1001']]) {
      const forged = parts.map((p, i) => (i === idx ? v : p)).join('.')
      assert.equal(await reason(openStealthMessage(forged, { keyring: kr, sender: 's', type: 'state' })), 'tampered')
    }
  })

  it('malformed and plaintext input is refused with a distinct code', async () => {
    const kr = await ring()
    assert.equal(await reason(openStealthMessage('plain text', { keyring: kr, sender: 's', type: 'state' })), 'not-encrypted')
    assert.equal(await reason(openStealthMessage('v2.k1.x', { keyring: kr, sender: 's', type: 'state' })), 'malformed')
  })

  it('replay bounds: minSeq and maxAgeMs', async () => {
    const kr = await ring()
    const sealed = await sealStealthMessage(STATE, { keyring: kr, sender: 's', type: 'state', seq: 5, issuedAt: 1_000_000 })
    const base = { keyring: kr, sender: 's', type: 'state' }
    await openStealthMessage(sealed, { ...base, minSeq: 5 })
    assert.equal(await reason(openStealthMessage(sealed, { ...base, minSeq: 6 })), 'replayed')
    await openStealthMessage(sealed, { ...base, maxAgeMs: 60_000, now: 1_050_000 })
    assert.equal(await reason(openStealthMessage(sealed, { ...base, maxAgeMs: 60_000, now: 1_061_000 })), 'stale')
  })

  it('nonces are unique across many messages and look uniform', async () => {
    const kr = await ring()
    const seen = new Set()
    const perByte = Array.from({ length: 12 }, () => new Set())
    const N = 5000
    for (let i = 0; i < N; i++) {
      const sealed = await sealStealthMessage('x', { keyring: kr, sender: 's', type: 'state' })
      const b64 = sealed.split('.')[4].replace(/-/g, '+').replace(/_/g, '/')
      const iv = Buffer.from(b64, 'base64').subarray(0, 12)
      seen.add(iv.toString('hex'))
      iv.forEach((b, j) => perByte[j].add(b))
    }
    assert.equal(seen.size, N)
    for (const s of perByte) assert.ok(s.size >= 240, `byte position saw only ${s.size} distinct values`)
  })

  it('a key refuses to seal past its message budget (rotate instead of risking nonce reuse)', async () => {
    const kr = await StealthKeyring.fromGroupSecrets('g', [{ id: 'k1', secret: secretA }], 'k1', { maxSealsPerKey: 3 })
    for (let i = 0; i < 3; i++) await sealStealthMessage('x', { keyring: kr, sender: 's', type: 'state' })
    assert.equal(await reason(sealStealthMessage('x', { keyring: kr, sender: 's', type: 'state' })), 'key-exhausted')
  })

  it('key rotation with overlap: old messages open while both keys are held, new ones use the new key', async () => {
    const oldRing = await ring([{ id: 'k1', secret: secretA }])
    const oldMsg = await sealStealthMessage(STATE, { keyring: oldRing, sender: 's', type: 'state' })
    const both = await ring([{ id: 'k1', secret: secretA }, { id: 'k2', secret: secretB }], 'k2')
    assert.equal(both.currentId, 'k2')
    const newMsg = await sealStealthMessage(STATE, { keyring: both, sender: 's', type: 'state' })
    assert.ok(newMsg.startsWith('v2.k2.'))
    const o = { sender: 's', type: 'state' }
    assert.equal((await openStealthMessage(oldMsg, { keyring: both, ...o })).keyId, 'k1')
    assert.equal((await openStealthMessage(newMsg, { keyring: both, ...o })).keyId, 'k2')
    // a member that still only has k1 cannot read the new one, and after k1 is dropped the old one is gone
    assert.equal(await reason(openStealthMessage(newMsg, { keyring: oldRing, ...o })), 'unknown-key')
    both.remove('k1')
    assert.equal(await reason(openStealthMessage(oldMsg, { keyring: both, ...o })), 'unknown-key')
    assert.throws(() => both.remove('k2'), /current/)
  })

  it('validates key ids', async () => {
    await assert.rejects(StealthKeyring.fromGroupSecrets('g', [{ id: 'a.b', secret: secretA }]), /key id/)
    await assert.rejects(StealthKeyring.fromGroupSecrets('g', []), /at least one/)
  })
})

describe('StealthAgent with a keyring', () => {
  it('round-trips, the DHT holds no plaintext, and a plaintext reader gets only ciphertext', async () => {
    const a = agent(await ring())
    const m = await a.hideEncrypted(STATE)
    assert.equal(m.encrypted, true)
    assert.equal(m.keyId, 'k1')
    assert.equal(await a.reconstituteEncrypted(), STATE)
    assert.ok(!a.reconstitute().includes('launch'))
  })

  it('a peer without the key fails quietly and is counted', async () => {
    const dht = new DhtNode({ localId: 'n', sendFn: () => {} })
    await agent(await ring(), dht).hideEncrypted(STATE)
    const stranger = agent(await ring([{ id: 'k1', secret: secretB }]), dht)
    for (let i = 0; i < 5; i++) {
      const r = await stranger.tryReconstituteEncrypted()
      assert.deepEqual(r, { ok: false, reason: 'tampered' })
    }
    const unkeyed = agent(undefined, dht)
    assert.deepEqual(await unkeyed.tryReconstituteEncrypted(), { ok: false, reason: 'no-key' })
    assert.equal(stranger.stats.tampered, 5)
    assert.equal(unkeyed.stats.noKey, 1)
    assert.equal(stranger.stats.opened, 0)
  })

  it('plaintext state is reported as not-encrypted, not an error', async () => {
    const dht = new DhtNode({ localId: 'n', sendFn: () => {} })
    agent(undefined, dht).hide('plain')
    const a = agent(await ring(), dht)
    assert.deepEqual(await a.tryReconstituteEncrypted(), { ok: false, reason: 'not-encrypted' })
    assert.equal(a.stats.notEncrypted, 1)
  })

  it('missing shards are reported as unavailable', async () => {
    const a = agent(await ring())
    assert.deepEqual(await a.tryReconstituteEncrypted(), { ok: false, reason: 'unavailable' })
    assert.equal(a.stats.unavailable, 1)
  })

  it('replaying an older sealed state is refused after a newer one was written', async () => {
    const dht = new DhtNode({ localId: 'n', sendFn: () => {} })
    const kr = await ring()
    const a = agent(kr, dht)
    await a.hideEncrypted('state one')
    const old = []
    for (let i = 0; i < 5; i++) old.push(dht.get(`stealth:agent-007:shard:${i}`))
    await a.hideEncrypted('state two')
    assert.equal(await a.reconstituteEncrypted(), 'state two')
    for (let i = 0; i < 5; i++) dht.store(`stealth:agent-007:shard:${i}`, old[i])
    assert.deepEqual(await a.tryReconstituteEncrypted(), { ok: false, reason: 'replayed' })
    assert.equal(a.stats.replayed, 1)
    await assert.rejects(a.reconstituteEncrypted(), (e) => e.code === 'replayed')
  })

  it('rotation: state sealed under the old key stays readable while both keys are held', async () => {
    const dht = new DhtNode({ localId: 'n', sendFn: () => {} })
    const kr = await ring([{ id: 'k1', secret: secretA }])
    const a = agent(kr, dht)
    await a.hideEncrypted(STATE)
    await kr.add('k2', secretB, { groupId: 'group-a', makeCurrent: true })
    assert.equal(await a.reconstituteEncrypted(), STATE)
    assert.equal((await a.hideEncrypted('next')).keyId, 'k2')
    assert.equal(await a.reconstituteEncrypted(), 'next')
  })

  it('the existing key option and v1 path are unchanged', async () => {
    const { deriveStealthKey } = await import('../src/index.mjs')
    const a = new StealthAgent({
      agentId: 'agent-007', dhtNode: new DhtNode({ localId: 'n', sendFn: () => {} }),
      key: await deriveStealthKey(secretA, 'group-a'),
    })
    await a.hideEncrypted(STATE)
    assert.ok(a.reconstitute().startsWith('v1.'))
    assert.equal(await a.reconstituteEncrypted(), STATE)
  })
})
