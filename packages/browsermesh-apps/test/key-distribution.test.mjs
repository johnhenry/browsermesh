/**
 * Unit-level tests for key-distribution.mjs (Phase E of the CloudStorage
 * plan -- see that file's own module doc comment for the full protocol/
 * trust-model writeup).
 *
 * Matches this family's established pattern for this kind of test
 * (grant-log.test.mjs is the direct precedent, itself citing
 * mesh-relay.test.mjs): real `PeerRegistry`s wired to real `MeshACL`
 * (`@johnhenry/browsermesh-core`), real Ed25519 `IdentityWallet`/
 * `MeshIdentityManager` identities (not mocked -- this phase's whole point is
 * genuine signature verification and genuine X25519 ECDH), real `GrantLog`s
 * (Phase D) driving real `CloudStorageBackend`s (Phase B) via a real
 * `IndexedDBChunkStore`/fake-indexeddb, connected via a minimal duck-typed
 * in-memory bus (not real WebRTC) -- exactly grant-log.test.mjs's own
 * `wireNodes()`.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/key-distribution.test.mjs
 */

import 'fake-indexeddb/auto'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { PeerRegistry } from '../src/peer-registry.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { createGrantLogService } from '../src/grant-log.mjs'
import { createKeyDistributionService } from '../src/key-distribution.mjs'
import { CloudStorageBackend } from '../src/cloud-storage-backend.mjs'
import { IndexedDBSyncStorage } from '@johnhenry/browsermesh-sync'
import {
  IdentityWallet,
  MeshIdentityManager,
  MeshPeerManager,
  TrustGraph,
  MeshACL,
  encodeBase64url,
} from '@johnhenry/browsermesh-core'

// ---------------------------------------------------------------------------
// Test fixtures (mirrors grant-log.test.mjs's own createPeer()/wireNodes())
// ---------------------------------------------------------------------------

/** A real Ed25519 identity + wallet + registry bundle for one "peer". */
async function createPeer(label) {
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

/** A minimal duck-typed `PeerNode` pair wired directly to each other over an async bus. */
function wireNodes(peerA, peerB) {
  const listenersA = new Set()
  const listenersB = new Set()

  const nodeA = {
    podId: peerA.podId,
    wallet: peerA.wallet,
    registry: peerA.registry,
    onIncomingData(cb) {
      listenersA.add(cb)
      return () => listenersA.delete(cb)
    },
    async sendTo(pubKey, data) {
      queueMicrotask(() => {
        for (const cb of listenersB) cb(peerA.podId, data)
      })
    },
  }
  const nodeB = {
    podId: peerB.podId,
    wallet: peerB.wallet,
    registry: peerB.registry,
    onIncomingData(cb) {
      listenersB.add(cb)
      return () => listenersB.delete(cb)
    },
    async sendTo(pubKey, data) {
      queueMicrotask(() => {
        for (const cb of listenersA) cb(peerB.podId, data)
      })
    },
  }
  return { nodeA, nodeB }
}

/** Poll until `fn()` is truthy, or throw after `timeoutMs`. */
async function waitFor(fn, timeoutMs = 1000, what = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}

/** Attach a paired GrantLog + key-distribution service to one node, per key-distribution.mjs's documented composition order. */
function attachBucketServices(node, resource, { getLocalKey, setReceivedKey }) {
  let grantLogApi
  const keyDist = attachService(node, undefined, createKeyDistributionService({
    resource,
    getLocalKey,
    setReceivedKey,
    getEffective: () => grantLogApi.effective(),
  }))
  const grantLog = attachService(node, undefined, createGrantLogService({
    resource,
    onGrantChange: keyDist.api.handleGrantChange,
    onReady: (api) => { grantLogApi = api },
  }))
  return { grantLogApi: () => grantLogApi, keyDistApi: keyDist.api, teardown: async () => { await keyDist.teardown(); await grantLog.teardown() } }
}

const RESOURCE = 's3:test-bucket'
let bucketCounter = 0
function freshBucketDbPrefix() {
  bucketCounter += 1
  return `key-dist-test-bucket-${bucketCounter}`
}

// ---------------------------------------------------------------------------
// End-to-end: grant -> key delivery -> recipient actually decrypts content
// ---------------------------------------------------------------------------

describe('createKeyDistributionService: end-to-end key delivery', () => {
  /** @type {any} */ let alice
  /** @type {any} */ let bob
  /** @type {any} */ let nodeA
  /** @type {any} */ let nodeB
  /** @type {string} */ let dbPrefix
  /** @type {CloudStorageBackend} */ let aliceBackend
  /** @type {CloudStorageBackend} */ let bobBackend

  beforeEach(async () => {
    alice = await createPeer('alice')
    bob = await createPeer('bob')
    ;({ nodeA, nodeB } = wireNodes(alice, bob))

    dbPrefix = freshBucketDbPrefix()
    // Alice's backend owns the "real" chunk store + manifest. Bob's backend
    // points at the SAME underlying chunk/manifest databases (simulating
    // Phase G's not-yet-built chunk replication having already happened --
    // explicitly out of this phase's scope, see cloud-storage-backend.mjs's
    // Phase E doc addition) but gets its OWN, separate, empty key storage --
    // exactly the thing this phase's key-distribution channel must populate
    // before Bob can decrypt anything.
    aliceBackend = new CloudStorageBackend({ bucket: 'test-bucket', dbName: dbPrefix })
    bobBackend = new CloudStorageBackend({
      bucket: 'test-bucket',
      dbName: dbPrefix,
      keyStorage: new IndexedDBSyncStorage({ dbName: `${dbPrefix}-bob-keys` }),
    })
  })

  it('granting a peer read access delivers the bucket key, and the recipient can decrypt content it never itself encrypted', async () => {
    const aliceServices = attachBucketServices(nodeA, RESOURCE, {
      getLocalKey: () => aliceBackend.peekKeyRaw(),
      setReceivedKey: (bytes) => aliceBackend.importKeyRaw(bytes),
    })
    const bobServices = attachBucketServices(nodeB, RESOURCE, {
      getLocalKey: () => bobBackend.peekKeyRaw(),
      setReceivedKey: (bytes) => bobBackend.importKeyRaw(bytes),
    })

    // Alice creates the bucket (bootstraps herself as GrantLog admin) and
    // writes real encrypted content via her own CloudStorageBackend.
    await aliceServices.grantLogApi().bootstrapAdmin()
    const socket = await aliceBackend.connect()
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    const plaintext = 'only bob should be able to read this'
    await socket.write(encoder.encode(JSON.stringify({
      op: 'put', key: 'secret.txt', data: Buffer.from(plaintext, 'utf8').toString('base64'),
    })))
    await socket.read()

    // Bob has no key yet -- he was never granted anything.
    assert.equal(await bobBackend.peekKeyRaw(), null)

    // Grant Bob read access, then sync the GrantLog to him -- this is what
    // triggers the announce/deliver handshake documented in
    // key-distribution.mjs's module doc comment.
    await aliceServices.grantLogApi().grant(bob.podId, ['read'])
    await aliceServices.grantLogApi().syncWith(bob.podId)

    await waitFor(async () => (await bobBackend.peekKeyRaw()) !== null, 2000, 'bob receives and stores the bucket key')

    // The delivered key must be byte-identical to Alice's own key.
    const aliceKey = await aliceBackend.peekKeyRaw()
    const bobKey = await bobBackend.peekKeyRaw()
    assert.deepEqual(bobKey, aliceKey)

    // Prove it's actually usable: Bob's OWN CloudStorageBackend instance
    // (which never itself wrote this content) can decrypt Alice's chunks.
    const bobSocket = await bobBackend.connect()
    await bobSocket.write(encoder.encode(JSON.stringify({ op: 'get', key: 'secret.txt' })))
    const chunk = await bobSocket.read()
    const res = JSON.parse(decoder.decode(chunk))
    assert.equal(res.error, undefined)
    assert.equal(Buffer.from(res.data, 'base64').toString('utf8'), plaintext)

    await aliceServices.teardown()
    await bobServices.teardown()
  })

  it('a peer that was never granted access never receives a key', async () => {
    const carol = await createPeer('carol')
    const { nodeA: nodeAC, nodeB: nodeC } = wireNodes(alice, carol)
    const carolBackend = new CloudStorageBackend({
      bucket: 'test-bucket',
      dbName: dbPrefix,
      keyStorage: new IndexedDBSyncStorage({ dbName: `${dbPrefix}-carol-keys` }),
    })

    const aliceServices = attachBucketServices(nodeAC, RESOURCE, {
      getLocalKey: () => aliceBackend.peekKeyRaw(),
      setReceivedKey: (bytes) => aliceBackend.importKeyRaw(bytes),
    })
    const carolServices = attachBucketServices(nodeC, RESOURCE, {
      getLocalKey: () => carolBackend.peekKeyRaw(),
      setReceivedKey: (bytes) => carolBackend.importKeyRaw(bytes),
    })

    await aliceServices.grantLogApi().bootstrapAdmin()
    await aliceBackend.exportKeyRaw() // Alice actually holds a key (auto-creates it).

    // Sync the (grant-less, Carol-less) GrantLog to Carol, and have Carol
    // announce herself the way a legitimately-granted peer would -- Carol is
    // simulating an attacker/onlooker who knows the protocol but was never
    // actually granted anything.
    await aliceServices.grantLogApi().syncWith(carol.podId)
    await carolServices.keyDistApi.localEncryptionPublicKey() // force Carol's keypair to exist
    // Directly invoke what a real announce would trigger, since Carol
    // legitimately has nothing to react to (she was never granted access,
    // so her own GrantLog never fires onGrantChange for herself).
    await nodeC.sendTo(alice.podId, {
      type: 'bucket-key',
      resource: RESOURCE,
      kind: 'announce',
      encryptionPublicKey: await carolServices.keyDistApi.localEncryptionPublicKey(),
    })

    // Give any (incorrect) delivery a real chance to happen.
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(await carolBackend.peekKeyRaw(), null, 'carol must never receive the bucket key')

    await aliceServices.teardown()
    await carolServices.teardown()
  })
})

// ---------------------------------------------------------------------------
// Rejection of forged/unauthorized deliver messages
// ---------------------------------------------------------------------------

describe('createKeyDistributionService: forged/unauthorized deliver rejection', () => {
  /** @type {any} */ let alice
  /** @type {any} */ let bob
  /** @type {any} */ let nodeA
  /** @type {any} */ let nodeB
  /** @type {string} */ let dbPrefix
  /** @type {CloudStorageBackend} */ let aliceBackend
  /** @type {CloudStorageBackend} */ let bobBackend
  /** @type {any} */ let aliceServices
  /** @type {any} */ let bobServices

  beforeEach(async () => {
    alice = await createPeer('alice')
    bob = await createPeer('bob')
    ;({ nodeA, nodeB } = wireNodes(alice, bob))

    dbPrefix = freshBucketDbPrefix()
    aliceBackend = new CloudStorageBackend({ bucket: 'test-bucket', dbName: dbPrefix })
    bobBackend = new CloudStorageBackend({
      bucket: 'test-bucket',
      dbName: dbPrefix,
      keyStorage: new IndexedDBSyncStorage({ dbName: `${dbPrefix}-bob-keys` }),
    })

    aliceServices = attachBucketServices(nodeA, RESOURCE, {
      getLocalKey: () => aliceBackend.peekKeyRaw(),
      setReceivedKey: (bytes) => aliceBackend.importKeyRaw(bytes),
    })
    bobServices = attachBucketServices(nodeB, RESOURCE, {
      getLocalKey: () => bobBackend.peekKeyRaw(),
      setReceivedKey: (bytes) => bobBackend.importKeyRaw(bytes),
    })

    await aliceServices.grantLogApi().bootstrapAdmin()
    await aliceBackend.exportKeyRaw()
  })

  it('a validly-signed-by-the-real-admin deliver, but wrapped for the WRONG recipient key, is rejected (not actually encrypted to the recipient)', async () => {
    // Alice is the real admin and really does sign this record -- but the
    // envelope was wrapped for some OTHER X25519 key, not Bob's, so Bob's
    // unwrap must fail and the key must never be adopted. Simulates a relay
    // (or a bug) delivering a genuinely-admin-signed record that simply
    // isn't actually encrypted to this recipient.
    const rawKey = await aliceBackend.exportKeyRaw()
    const wrongKeyPair = await (await import('@johnhenry/browsermesh-core')).generateEncryptionKeyPair()
    const { wrapKeyForMember } = await import('@johnhenry/browsermesh-core')
    const cryptoKey = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
    const envelope = await wrapKeyForMember(cryptoKey, wrongKeyPair.publicKey) // wrapped for a throwaway key, NOT Bob's

    const at = Date.now()
    const signedBy = alice.podId
    const payload = new TextEncoder().encode(JSON.stringify(sortKeys({
      resource: RESOURCE, ephemeralPublicKey: envelope.ephemeralPublicKey, wrappedKey: envelope.wrappedKey, iv: envelope.iv, at, signedBy,
    })))
    const signature = await alice.wallet.sign(alice.podId, payload)

    // Bob must have a real keypair for the unwrap attempt to even run.
    await bobServices.keyDistApi.localEncryptionPublicKey()

    await nodeA.sendTo(bob.podId, {
      type: 'bucket-key',
      resource: RESOURCE,
      kind: 'deliver',
      envelope,
      at,
      signedBy,
      signedByPubKeyBytes: encodeBase64url(await alice.wallet.getPublicKeyBytes(alice.podId)),
      signature: encodeBase64url(signature),
    })

    await new Promise((r) => setTimeout(r, 50))
    assert.equal(await bobBackend.peekKeyRaw(), null, 'a deliver not actually encrypted to the recipient must never be accepted')
  })

  it('a deliver message with a bad/garbage signature is rejected', async () => {
    // Force Bob's X25519 keypair to exist so we have a real, valid recipient
    // public key to (mis-)target -- the bug under test is the SIGNATURE, not
    // the wrap target.
    const bobPubB64 = await bobServices.keyDistApi.localEncryptionPublicKey()

    await nodeA.sendTo(bob.podId, {
      type: 'bucket-key',
      resource: RESOURCE,
      kind: 'deliver',
      envelope: { ephemeralPublicKey: bobPubB64, wrappedKey: 'garbage', iv: 'Z2FyYmFnZQ==' },
      at: Date.now(),
      signedBy: alice.podId,
      signedByPubKeyBytes: encodeBase64url(await alice.wallet.getPublicKeyBytes(alice.podId)),
      signature: encodeBase64url(new Uint8Array(64)), // garbage, not a real signature
    })

    await new Promise((r) => setTimeout(r, 50))
    assert.equal(await bobBackend.peekKeyRaw(), null, 'a forged/garbage-signature deliver must never be accepted')
  })

  it('a deliver message validly self-signed by a non-admin/non-key-holder is rejected', async () => {
    // Bob himself signs a "deliver" claiming to hand himself the key -- his
    // signature is perfectly real (he really did sign it with his own key),
    // but he has no authority/grant on this resource at all, so it must
    // never be accepted, matching grant-log.test.mjs's own "valid signature,
    // no authority" precedent.
    const carol = await createPeer('carol')
    const { nodeA: nodeBC, nodeB: nodeC } = wireNodes(bob, carol)
    const carolBackend = new CloudStorageBackend({
      bucket: 'test-bucket',
      dbName: dbPrefix,
      keyStorage: new IndexedDBSyncStorage({ dbName: `${dbPrefix}-carol-keys` }),
    })
    const carolServices = attachBucketServices(nodeC, RESOURCE, {
      getLocalKey: () => carolBackend.peekKeyRaw(),
      setReceivedKey: (bytes) => carolBackend.importKeyRaw(bytes),
    })
    const carolPubB64 = await carolServices.keyDistApi.localEncryptionPublicKey()

    const { wrapKeyForMember } = await import('@johnhenry/browsermesh-core')
    const bogusKeyBytes = new Uint8Array(32).fill(7)
    const bogusCryptoKey = await crypto.subtle.importKey('raw', bogusKeyBytes, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
    const carolRaw = Buffer.from(carolPubB64, 'base64')
    const carolPublicKey = await crypto.subtle.importKey('raw', carolRaw, { name: 'X25519' }, true, [])
    const envelope = await wrapKeyForMember(bogusCryptoKey, carolPublicKey)

    const at = Date.now()
    const signedBy = bob.podId
    const payload = new TextEncoder().encode(JSON.stringify(sortKeys({
      resource: RESOURCE, ephemeralPublicKey: envelope.ephemeralPublicKey, wrappedKey: envelope.wrappedKey, iv: envelope.iv, at, signedBy,
    })))
    const signature = await bob.wallet.sign(bob.podId, payload)

    await nodeBC.sendTo(carol.podId, {
      type: 'bucket-key',
      resource: RESOURCE,
      kind: 'deliver',
      envelope,
      at,
      signedBy,
      signedByPubKeyBytes: encodeBase64url(await bob.wallet.getPublicKeyBytes(bob.podId)),
      signature: encodeBase64url(signature),
    })

    await new Promise((r) => setTimeout(r, 50))
    assert.equal(await carolBackend.peekKeyRaw(), null, 'a validly-signed but unauthorized deliver must never be accepted')

    await carolServices.teardown()
  })
})

/** Mirrors grant-log.mjs's own canonicalJSON key-sorting for the hand-built fixtures above. */
function sortKeys(obj) {
  const sorted = {}
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k]
  return sorted
}
