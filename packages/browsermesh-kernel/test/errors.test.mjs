import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  KernelError, HandleNotFoundError, HandleTypeMismatchError,
  TableFullError, StreamClosedError, CapabilityDeniedError,
  AlreadyRegisteredError, NotFoundError,
} from '../src/errors.mjs';

describe('KernelError', () => {
  it('extends Error', () => {
    const err = new KernelError('test', 'ETEST');
    assert.ok(err instanceof Error);
    assert.ok(err instanceof KernelError);
    assert.equal(err.message, 'test');
    assert.equal(err.code, 'ETEST');
    assert.equal(err.name, 'KernelError');
  });
});

describe('HandleNotFoundError', () => {
  it('has correct properties', () => {
    const err = new HandleNotFoundError('res_42');
    assert.ok(err instanceof KernelError);
    assert.equal(err.name, 'HandleNotFoundError');
    assert.equal(err.code, 'ENOHANDLE');
    assert.equal(err.handle, 'res_42');
    assert.ok(err.message.includes('res_42'));
  });
});

describe('HandleTypeMismatchError', () => {
  it('has correct properties', () => {
    const err = new HandleTypeMismatchError('res_1', 'stream', 'port');
    assert.ok(err instanceof KernelError);
    assert.equal(err.name, 'HandleTypeMismatchError');
    assert.equal(err.code, 'EHANDLETYPE');
    assert.equal(err.handle, 'res_1');
    assert.equal(err.expected, 'stream');
    assert.equal(err.actual, 'port');
  });
});

describe('TableFullError', () => {
  it('has correct properties', () => {
    const err = new TableFullError(4096);
    assert.ok(err instanceof KernelError);
    assert.equal(err.name, 'TableFullError');
    assert.equal(err.code, 'ETABLEFULL');
    assert.equal(err.maxSize, 4096);
  });
});

describe('StreamClosedError', () => {
  it('has correct properties', () => {
    const err = new StreamClosedError();
    assert.ok(err instanceof KernelError);
    assert.equal(err.name, 'StreamClosedError');
    assert.equal(err.code, 'ESTREAMCLOSED');
  });
});

describe('CapabilityDeniedError', () => {
  it('has correct properties', () => {
    const err = new CapabilityDeniedError('net');
    assert.ok(err instanceof KernelError);
    assert.equal(err.name, 'CapabilityDeniedError');
    assert.equal(err.code, 'ECAPDENIED');
    assert.equal(err.capability, 'net');
  });
});

describe('AlreadyRegisteredError', () => {
  it('has correct properties', () => {
    const err = new AlreadyRegisteredError('myService');
    assert.ok(err instanceof KernelError);
    assert.equal(err.name, 'AlreadyRegisteredError');
    assert.equal(err.code, 'EALREADY');
    assert.equal(err.identifier, 'myService');
  });
});

describe('NotFoundError', () => {
  it('has correct properties', () => {
    const err = new NotFoundError('missing');
    assert.ok(err instanceof KernelError);
    assert.equal(err.name, 'NotFoundError');
    assert.equal(err.code, 'ENOTFOUND');
    assert.equal(err.identifier, 'missing');
  });
});
