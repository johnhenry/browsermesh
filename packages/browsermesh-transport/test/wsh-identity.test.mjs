// Run with: node --import ./test/_setup-globals.mjs --test test/wsh-identity.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PodIdentity } from '@johnhenry/browsermesh-primitives';
import {
  podIdToFingerprint,
  fingerprintToPodId,
  rendezvousId,
  initiatorWins,
  podIdFromRawKey,
  resolveCredential,
} from '../src/wsh-links.mjs';
import { MeshWshBridge } from '../src/wsh-bridge.mjs';

describe('wsh identity mapping', () => {
  it('maps a pod id to the wsh fingerprint of the same key and back', async () => {
    const id = await PodIdentity.generate();
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', id.keyPair.publicKey));
    const hex = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)), (b) => b.toString(16).padStart(2, '0')).join('');
    assert.equal(podIdToFingerprint(id.podId), hex);
    assert.equal(fingerprintToPodId(hex), id.podId);
    assert.equal(await podIdFromRawKey(raw), id.podId);
  });

  it('agrees with what wsh itself computes for the same key', async () => {
    const wsh = await import('@johnhenry/wsh');
    const id = await PodIdentity.generate();
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', id.keyPair.publicKey));
    assert.equal(podIdToFingerprint(id.podId), await wsh.fingerprint(raw));
    assert.equal(id.podId, await wsh.podId(raw));
  });

  it('MeshWshBridge converts with the same functions (one source of truth)', async () => {
    const id = await PodIdentity.generate();
    const bridge = new MeshWshBridge({}, {});
    assert.equal(bridge.podId2fingerprint(id.podId), podIdToFingerprint(id.podId));
    assert.equal(bridge.fingerprint2podId(podIdToFingerprint(id.podId)), id.podId);
  });

  it('refuses things that are not a pod id or a fingerprint', () => {
    assert.throws(() => podIdToFingerprint('not base64url!'), TypeError);
    assert.throws(() => podIdToFingerprint('AAAA'), TypeError, 'a pod id is 32 bytes');
    assert.throws(() => fingerprintToPodId('zz'), TypeError);
    assert.throws(() => fingerprintToPodId('ab'), TypeError, 'a fingerprint is 32 bytes');
  });
});

describe('wsh rendezvous id', () => {
  it('is deterministic, distinct per pod, and a valid pipe relay id', async () => {
    const a = await PodIdentity.generate();
    const b = await PodIdentity.generate();
    const ra = await rendezvousId(a.podId);
    assert.equal(ra, await rendezvousId(a.podId));
    assert.notEqual(ra, await rendezvousId(b.podId));
    assert.match(ra, /^[A-Za-z0-9_-]{22,128}$/);
    const { pipeUrl } = await import('@johnhenry/wsh/pipe-relay');
    assert.doesNotThrow(() => pipeUrl('wss://relay.example', ra));
  });
});

describe('wsh simultaneous dial tie-break', () => {
  it('picks the link whose initiator has the smaller pod id, the same on both sides', () => {
    const lo = 'AAAA_lo';
    const hi = 'zzzz_hi';
    // A (lo) dialled B (hi) and B dialled A.
    // From A's side: its own dial is initiated by lo, the inbound by hi.
    assert.equal(initiatorWins(lo, hi), true);
    assert.equal(initiatorWins(hi, lo), false);
    // Both sides evaluate the same two initiators and so pick the same link.
  });

  it('is a strict order (never a tie for two different pods)', () => {
    assert.equal(initiatorWins('x', 'x'), false);
  });
});

describe('wsh credential', () => {
  it('accepts a PodIdentity and checks the pod id is the hash of its key', async () => {
    const id = await PodIdentity.generate();
    const cred = await resolveCredential(id);
    assert.equal(cred.podId, id.podId);
    assert.ok(cred.keyPair);
  });

  it('refuses an identity whose pod id is not the hash of its key', async () => {
    const id = await PodIdentity.generate();
    const other = await PodIdentity.generate();
    await assert.rejects(() => resolveCredential({ podId: other.podId, keyPair: id.keyPair }), /pod id/);
  });

  it('accepts a signer for a key held elsewhere', async () => {
    const id = await PodIdentity.generate();
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', id.keyPair.publicKey));
    const signer = { publicKey: raw, sign: (data) => id.sign(data) };
    const cred = await resolveCredential({ podId: id.podId, signer });
    assert.equal(cred.podId, id.podId);
    assert.ok(cred.signer);
  });
});
