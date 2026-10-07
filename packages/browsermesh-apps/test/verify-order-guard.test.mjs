// Run with: node --import ./test/_setup-globals.mjs --test test/verify-order-guard.test.mjs
//
// Caller-supplied verifyFn callbacks (PaymentChannel, chat service, GrantLog
// wallet, key-distribution wallet) must take (publicKey, signature, data).
// An old-order callback used to return false silently; a one-time self-test
// against a known-good Ed25519 vector now turns that into a TypeError.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {
  selfTestVerifyFn,
  guardVerifyFn,
  guardVerifyMethod,
  assertIdentityFirst,
  isVerifyOrderError,
} from '../src/internal/verify-order.mjs'
import { PaymentChannel } from '../src/payments.mjs'
import { PeerChat } from '../src/peer-chat.mjs'
import { PeerRegistry } from '../src/peer-registry.mjs'
import { GrantLog } from '../src/grant-log.mjs'
import { TimestampProof } from '../src/peer-timestamp.mjs'
import { IdentityWallet, MeshIdentityManager, MeshPeerManager, TrustGraph, MeshACL } from '@johnhenry/browsermesh-core'

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
function rawVerify(pub, sig, data) {
  const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(pub)]), format: 'der', type: 'spki' })
  return crypto.verify(null, Buffer.from(data), key, Buffer.from(sig))
}

/** Correct: (publicKey, signature, data). */
const newOrderVerify = async (pub, sig, data) => rawVerify(pub, sig, data)
/** Wrong: the pre-0.2.0 (publicKey, data, signature). */
const oldOrderVerify = async (pub, data, sig) => rawVerify(pub, sig, data)

const throwsOrderError = (err) => {
  assert.ok(err instanceof TypeError, 'is a TypeError')
  assert.ok(isVerifyOrderError(err))
  assert.match(err.message, /\(publicKey, signature, data\)/)
  return true
}

describe('selfTestVerifyFn', () => {
  it('passes a new-order callback', async () => {
    await selfTestVerifyFn(newOrderVerify, 'test')
  })

  it('throws a TypeError naming the new order for an old-order callback', async () => {
    await assert.rejects(selfTestVerifyFn(oldOrderVerify, 'test'), throwsOrderError)
  })

  it('does not throw for callbacks that reject both orders or throw (undetectable)', async () => {
    await selfTestVerifyFn(async () => false, 'test')
    await selfTestVerifyFn(async () => { throw new Error('unknown key') }, 'test')
    await selfTestVerifyFn(() => 'not-a-boolean', 'test')
  })
})

describe('guardVerifyFn', () => {
  it('returns non-functions unchanged and skips the self-test in production', () => {
    assert.equal(guardVerifyFn(undefined, 'x'), undefined)
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      assert.equal(guardVerifyFn(oldOrderVerify, 'x'), oldOrderVerify)
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = prev
    }
  })

  it('forwards real calls of a new-order callback', async () => {
    let seen
    const g = guardVerifyFn(async (...a) => { seen = a; return true }, 'x')
    assert.equal(await g('k', 's', 'd'), true)
    assert.deepEqual(seen, ['k', 's', 'd'])
  })

  it('rejects every call, stickily, for an old-order callback', async () => {
    const g = guardVerifyFn(oldOrderVerify, 'x')
    await assert.rejects(g(new Uint8Array(32), new Uint8Array(64), new Uint8Array(3)), throwsOrderError)
    await assert.rejects(g(new Uint8Array(32), new Uint8Array(64), new Uint8Array(3)), throwsOrderError)
  })
})

describe('guardVerifyMethod', () => {
  it('passes a new-order wallet and throws for an old-order wallet', async () => {
    const good = guardVerifyMethod({ verify: newOrderVerify }, 'w')
    assert.equal(await good(new Uint8Array(32), new Uint8Array(64), new Uint8Array(1)), false)
    const bad = guardVerifyMethod({ verify: oldOrderVerify }, 'w')
    await assert.rejects(bad(new Uint8Array(32), new Uint8Array(64), new Uint8Array(1)), throwsOrderError)
  })
})

describe('PaymentChannel verifyFn order', () => {
  const pair = (verifyFn) => {
    const id = 'ch_order_00'
    const mk = (a, b) => new PaymentChannel(a, b, {
      channelId: id,
      signFn: async () => new Uint8Array(64).fill(7),
      verifyFn,
      remotePublicKey: new Uint8Array(32).fill(1),
    })
    const A = mk('pod-a', 'pod-b'); const B = mk('pod-b', 'pod-a')
    A.open(100); B.open(100)
    return { A, B }
  }

  it('an old-order verifyFn makes receive() throw a TypeError instead of returning false', async () => {
    const { A, B } = pair(oldOrderVerify)
    const update = await A.pay(5)
    await assert.rejects(B.receive(update), throwsOrderError)
  })

  it('a new-order verifyFn keeps working (a bad signature is still just rejected)', async () => {
    const { A, B } = pair(newOrderVerify)
    const update = await A.pay(5)
    await assert.rejects(B.receive(update), (err) => !isVerifyOrderError(err))
  })
})

describe('PeerChat verifyFn order', () => {
  const envelope = () => ({ from: 'alice', text: 'hi', timestamp: Date.now(), signature: Buffer.alloc(64, 1).toString('base64') })

  it('an old-order verifyFn makes receiveEnvelope() throw a TypeError', async () => {
    const chat = new PeerChat({ localPubKey: 'local', send: async () => {}, verifyFn: oldOrderVerify })
    await assert.rejects(chat.receiveEnvelope('alice', envelope()), throwsOrderError)
  })

  it('a new-order verifyFn marks a bad signature unverified without throwing', async () => {
    const chat = new PeerChat({ localPubKey: 'local', send: async () => {}, verifyFn: newOrderVerify })
    await chat.receiveEnvelope('alice', envelope())
    assert.equal(chat.getHistory()[0].verified, false)
  })
})

describe('GrantLog wallet.verify order', () => {
  async function peer(label) {
    const identityManager = new MeshIdentityManager({})
    const wallet = new IdentityWallet({ identityManager })
    const { podId } = await wallet.createIdentity(label)
    const registry = new PeerRegistry({
      localPodId: podId,
      peerManager: new MeshPeerManager({}),
      trustGraph: new TrustGraph(),
      acl: new MeshACL({ owner: podId }),
    })
    return { podId, wallet, registry }
  }

  it('an old-order wallet.verify makes mergeRemote() throw a TypeError', async () => {
    const alice = await peer('alice'); const bob = await peer('bob')
    const aliceLog = new GrantLog({ resource: 's3:x', localPodId: alice.podId, wallet: alice.wallet, registry: alice.registry })
    await aliceLog.bootstrapAdmin()
    const badWallet = {
      sign: (...a) => bob.wallet.sign(...a),
      getPublicKeyBytes: (...a) => bob.wallet.getPublicKeyBytes(...a),
      verify: oldOrderVerify,
    }
    const bobLog = new GrantLog({ resource: 's3:x', localPodId: bob.podId, wallet: badWallet, registry: bob.registry })
    await assert.rejects(bobLog.mergeRemote(aliceLog.toJSON()), throwsOrderError)
  })
})

describe('peer-timestamp (identity, signature, data) order', () => {
  const proof = () => new TimestampProof({
    eventHash: 'abc', canonicalTimestamp: 1, issuedBy: 'pod-x', confidence: 1,
    signature: Buffer.alloc(64, 1).toString('base64'),
    witnesses: [{ podId: 'p', localTimestamp: 1, signature: Buffer.alloc(64, 2).toString('base64') }],
  })

  it('TimestampProof.verify calls verifyFn(signerPodId, signature, data)', async () => {
    const calls = []
    await proof().verify(async (...a) => { calls.push(a); return true })
    assert.equal(calls[0][0], 'pod-x')
    assert.ok(calls[0][1] instanceof Uint8Array && calls[0][1].length === 64)
    assert.equal(calls[0][2], 'abc:1')
  })

  it('the authority adapter throws a TypeError when the first argument is a 64-byte signature', () => {
    assert.throws(() => assertIdentityFirst(new Uint8Array(64), 'identity.verify'), isVerifyOrderError)
    assert.doesNotThrow(() => assertIdentityFirst('pod-x', 'identity.verify'))
  })

  it('a signature-shaped identity makes TimestampProof.verify throw instead of reporting a failed check', async () => {
    const swapped = new TimestampProof({ ...proof(), issuedBy: new Uint8Array(64) })
    await assert.rejects(swapped.verify(async () => true), isVerifyOrderError)
  })
})
