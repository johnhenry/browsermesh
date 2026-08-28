/**
 * Identity, wire messages, and tampered-signature rejection.
 *
 * A Pod's identity (browsermesh-primitives' `PodIdentity`) is an Ed25519
 * key pair, plus a `podId` deterministically derived from the public key
 * (`derivePodId`) -- two identities generated from the same key material
 * always produce the same podId, which is what lets a peer be re-recognized
 * across reconnects without a central directory.
 *
 * Mesh messages travel as a compact binary wire format (`encodeMeshMessage`/
 * `decodeMeshMessage`), not JSON -- this example shows the format is a real
 * byte encoding (inspecting the type byte directly), round-trips exactly,
 * and that identity signatures reject tampering.
 */

import assert from 'node:assert/strict'
import {
  PodIdentity, derivePodId,
  MESH_TYPE, encodeMeshMessage, decodeMeshMessage,
} from '@johnhenry/browsermesh-primitives'

// ── Generate two identities ─────────────────────────────────────────

const alice = await PodIdentity.generate()
const bob = await PodIdentity.generate()

assert.notEqual(alice.podId, bob.podId)
console.log('alice podId:', alice.podId)
console.log('bob podId:  ', bob.podId)

// derivePodId is deterministic — re-deriving from the same public key
// reproduces the same podId without needing the private key.
const rederived = await derivePodId(alice.keyPair.publicKey)
assert.equal(rederived, alice.podId)
console.log('podId re-derivation from public key alone: matches ✓')

// ── Sign and verify ─────────────────────────────────────────────────

const data = new TextEncoder().encode('alice says hello to the mesh')
const signature = await alice.sign(data)

const genuine = await PodIdentity.verify(alice.keyPair.publicKey, data, signature)
assert.equal(genuine, true)
console.log('genuine signature:              verified ✓')

// Tampering 1: altered payload — same signature, fails.
const tampered = new TextEncoder().encode('alice says HELLO to the mesh')
const tamperedOk = await PodIdentity.verify(alice.keyPair.publicKey, tampered, signature)
assert.equal(tamperedOk, false)
console.log('tampered payload, same signature: rejected ✓')

// Tampering 2: genuine payload, wrong signer's key.
const wrongKeyOk = await PodIdentity.verify(bob.keyPair.publicKey, data, signature)
assert.equal(wrongKeyOk, false)
console.log('genuine payload, wrong signer:    rejected ✓')

// ── Wire format: encode/decode a real binary message ────────────────

const original = {
  type: MESH_TYPE.UNICAST,
  from: alice.podId,
  to: bob.podId,
  payload: { greeting: 'hello mesh', ts: Date.now() },
  ttl: 60,
}

const bytes = encodeMeshMessage(original)
assert.ok(bytes instanceof Uint8Array)
// The first byte is the real MESH_TYPE code, not part of a JSON string —
// this is a binary protocol, not JSON-over-the-wire.
assert.equal(bytes[0], MESH_TYPE.UNICAST)
console.log(`encoded UNICAST message: ${bytes.length} bytes, first byte = 0x${bytes[0].toString(16)}`)

const decoded = decodeMeshMessage(bytes)
assert.equal(decoded.from, alice.podId)
assert.equal(decoded.to, bob.podId)
assert.deepEqual(decoded.payload, original.payload)
console.log('decoded message round-trips exactly ✓')

console.log('ok: identity generation, deterministic podId, signature verification, and wire round-trip all check out')
