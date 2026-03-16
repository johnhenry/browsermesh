import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MeshError,
  MeshProtocolError,
  MeshCapabilityError,
} from '../src/errors.mjs';
import { MESH_ERROR } from '../src/constants.mjs';

describe('MeshError', () => {
  it('extends Error', () => {
    const err = new MeshError('test');
    assert.ok(err instanceof Error);
    assert.ok(err instanceof MeshError);
  });

  it('has correct name', () => {
    const err = new MeshError('test');
    assert.equal(err.name, 'MeshError');
  });

  it('has correct message', () => {
    const err = new MeshError('something went wrong');
    assert.equal(err.message, 'something went wrong');
  });

  it('defaults code to MESH_ERROR.UNKNOWN', () => {
    const err = new MeshError('test');
    assert.equal(err.code, MESH_ERROR.UNKNOWN);
  });

  it('accepts custom code', () => {
    const err = new MeshError('test', MESH_ERROR.MESSAGE_EXPIRED);
    assert.equal(err.code, MESH_ERROR.MESSAGE_EXPIRED);
  });
});

describe('MeshProtocolError', () => {
  it('extends MeshError', () => {
    const err = new MeshProtocolError('bad format');
    assert.ok(err instanceof MeshError);
    assert.ok(err instanceof MeshProtocolError);
  });

  it('has correct name', () => {
    const err = new MeshProtocolError('test');
    assert.equal(err.name, 'MeshProtocolError');
  });

  it('defaults code to MESH_ERROR.INVALID_FORMAT', () => {
    const err = new MeshProtocolError('test');
    assert.equal(err.code, MESH_ERROR.INVALID_FORMAT);
  });

  it('accepts custom code', () => {
    const err = new MeshProtocolError('test', MESH_ERROR.MESSAGE_EXPIRED);
    assert.equal(err.code, MESH_ERROR.MESSAGE_EXPIRED);
  });
});

describe('MeshCapabilityError', () => {
  it('extends MeshError', () => {
    const err = new MeshCapabilityError('denied');
    assert.ok(err instanceof MeshError);
    assert.ok(err instanceof MeshCapabilityError);
  });

  it('has correct name', () => {
    const err = new MeshCapabilityError('test');
    assert.equal(err.name, 'MeshCapabilityError');
  });

  it('has code MESH_ERROR.CAPABILITY_DENIED', () => {
    const err = new MeshCapabilityError('test');
    assert.equal(err.code, MESH_ERROR.CAPABILITY_DENIED);
  });

  it('stores requiredScope', () => {
    const err = new MeshCapabilityError('denied', 'mesh:crdt:write');
    assert.equal(err.requiredScope, 'mesh:crdt:write');
  });

  it('requiredScope is undefined when not provided', () => {
    const err = new MeshCapabilityError('denied');
    assert.equal(err.requiredScope, undefined);
  });
});
