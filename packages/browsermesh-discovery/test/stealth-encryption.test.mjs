// Run with: node --import ./test/_setup-globals.mjs --test test/stealth-encryption.test.mjs
// #230: opt-in AES-GCM payload encryption for StealthAgent, key derived per discovery group.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DhtNode, StealthAgent, deriveStealthKey, encryptStealthState, decryptStealthState } from '../src/index.mjs'

const secret = new Uint8Array(32).fill(7)
const STATE = JSON.stringify({ memory: ['the launch code is 0000'], n: 42 })

function agent(extra = {}, id = 'agent-007') {
  const dhtNode = extra.dhtNode ?? new DhtNode({ localId: 'n', sendFn: () => {} })
  return new StealthAgent({ agentId: id, dhtNode, threshold: 3, totalShards: 5, ...extra })
}

describe('stealth payload encryption (#230)', () => {
  it('round-trips and is not plaintext', async () => {
    const key = await deriveStealthKey(secret, 'group-a')
    const sealed = await encryptStealthState(STATE, key, 'agent-007')
    assert.equal(typeof sealed, 'string')
    assert.ok(!sealed.includes('launch'))
    assert.equal(await decryptStealthState(sealed, key, 'agent-007'), STATE)
  })

  it('uses a fresh IV each time', async () => {
    const key = await deriveStealthKey(secret, 'group-a')
    assert.notEqual(await encryptStealthState(STATE, key, 'a'), await encryptStealthState(STATE, key, 'a'))
  })

  it('a different group (or secret) derives a key that cannot decrypt', async () => {
    const a = await deriveStealthKey(secret, 'group-a')
    const b = await deriveStealthKey(secret, 'group-b')
    const sealed = await encryptStealthState(STATE, a, 'agent-007')
    await assert.rejects(decryptStealthState(sealed, b, 'agent-007'))
  })

  it('is bound to the agent id and rejects tampering', async () => {
    const key = await deriveStealthKey(secret, 'group-a')
    const sealed = await encryptStealthState(STATE, key, 'agent-007')
    await assert.rejects(decryptStealthState(sealed, key, 'agent-008'))
    const bad = sealed.slice(0, -2) + (sealed.endsWith('AA') ? 'BB' : 'AA')
    await assert.rejects(decryptStealthState(bad, key, 'agent-007'))
  })

  it('deriveStealthKey validates its inputs', async () => {
    await assert.rejects(deriveStealthKey(new Uint8Array(4), 'g'), /at least 16 bytes/)
    await assert.rejects(deriveStealthKey(secret, ''), /groupId/)
  })

  it('StealthAgent.hideEncrypted / reconstituteEncrypted round-trip and the DHT holds no plaintext', async () => {
    const dhtNode = new DhtNode({ localId: 'n', sendFn: () => {} })
    const key = await deriveStealthKey(secret, 'group-a')
    const a = agent({ dhtNode, key })
    const manifest = await a.hideEncrypted(STATE)
    assert.equal(manifest.encrypted, true)
    assert.equal(a.isViable(), true)
    assert.equal(await a.reconstituteEncrypted(), STATE)
    // the plain (unencrypted) reader recovers only ciphertext
    const raw = a.reconstitute()
    assert.ok(!raw.includes('launch'))
  })

  it('an agent with the wrong key cannot read what another group hid', async () => {
    const dhtNode = new DhtNode({ localId: 'n', sendFn: () => {} })
    const a = agent({ dhtNode, key: await deriveStealthKey(secret, 'group-a') })
    await a.hideEncrypted(STATE)
    const other = agent({ dhtNode, key: await deriveStealthKey(secret, 'group-b') })
    await assert.rejects(other.reconstituteEncrypted())
  })

  it('hideEncrypted requires a key; the plain sync API is unchanged', async () => {
    const a = agent()
    await assert.rejects(a.hideEncrypted(STATE), /key/)
    await assert.rejects(a.reconstituteEncrypted(), /key/)
    a.hide('plain')
    assert.equal(a.reconstitute(), 'plain')
  })
})
