import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MESH_TYPE, MESH_ERROR } from '../src/constants.mjs';

describe('MESH_TYPE', () => {
  it('is frozen', () => {
    assert.ok(Object.isFrozen(MESH_TYPE));
  });

  it('has expected message types', () => {
    assert.equal(typeof MESH_TYPE.UNICAST, 'number');
    assert.equal(typeof MESH_TYPE.BROADCAST, 'number');
    assert.equal(typeof MESH_TYPE.CAP_GRANT, 'number');
    assert.equal(typeof MESH_TYPE.CAP_REVOKE, 'number');
    assert.equal(typeof MESH_TYPE.TRUST_ATTEST, 'number');
    assert.equal(typeof MESH_TYPE.IDENTITY_ANNOUNCE, 'number');
    assert.equal(typeof MESH_TYPE.IDENTITY_DEPART, 'number');
    assert.equal(typeof MESH_TYPE.CRDT_SYNC, 'number');
    assert.equal(typeof MESH_TYPE.CONSENSUS_PROPOSE, 'number');
    assert.equal(typeof MESH_TYPE.CONSENSUS_VOTE, 'number');
    assert.equal(typeof MESH_TYPE.RESOURCE_CLAIM, 'number');
    assert.equal(typeof MESH_TYPE.RESOURCE_RELEASE, 'number');
    assert.equal(typeof MESH_TYPE.PING, 'number');
    assert.equal(typeof MESH_TYPE.PONG, 'number');
  });

  it('values are in allocated range 0xA0-0xF5', () => {
    for (const [name, code] of Object.entries(MESH_TYPE)) {
      assert.ok(
        code >= 0xa0 && code <= 0xf5,
        `${name} (0x${code.toString(16)}) is outside allocated range`
      );
    }
  });

  it('has no duplicate values', () => {
    const values = Object.values(MESH_TYPE);
    const unique = new Set(values);
    assert.equal(values.length, unique.size, 'MESH_TYPE has duplicate values');
  });
});

describe('MESH_ERROR', () => {
  it('is frozen', () => {
    assert.ok(Object.isFrozen(MESH_ERROR));
  });

  it('has expected error codes', () => {
    assert.equal(typeof MESH_ERROR.UNKNOWN, 'number');
    assert.equal(typeof MESH_ERROR.INVALID_FORMAT, 'number');
    assert.equal(typeof MESH_ERROR.CAPABILITY_DENIED, 'number');
    assert.equal(typeof MESH_ERROR.IDENTITY_INVALID, 'number');
    assert.equal(typeof MESH_ERROR.TRUST_INSUFFICIENT, 'number');
    assert.equal(typeof MESH_ERROR.MESSAGE_EXPIRED, 'number');
    assert.equal(typeof MESH_ERROR.RESOURCE_UNAVAILABLE, 'number');
    assert.equal(typeof MESH_ERROR.QUORUM_NOT_REACHED, 'number');
  });

  it('has no duplicate values', () => {
    const values = Object.values(MESH_ERROR);
    const unique = new Set(values);
    assert.equal(values.length, unique.size, 'MESH_ERROR has duplicate values');
  });

  it('UNKNOWN is 0', () => {
    assert.equal(MESH_ERROR.UNKNOWN, 0);
  });
});
