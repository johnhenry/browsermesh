import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { KERNEL_DEFAULTS, KERNEL_CAP, KERNEL_ERROR } from '../src/constants.mjs';

describe('KERNEL_DEFAULTS', () => {
  it('has expected keys', () => {
    assert.equal(KERNEL_DEFAULTS.MAX_RESOURCE_TABLE_SIZE, 4096);
    assert.equal(KERNEL_DEFAULTS.DEFAULT_STREAM_BUFFER_SIZE, 1024);
    assert.equal(KERNEL_DEFAULTS.DEFAULT_TRACER_CAPACITY, 1024);
    assert.equal(KERNEL_DEFAULTS.DEFAULT_LOGGER_CAPACITY, 1024);
  });

  it('is frozen', () => {
    assert.ok(Object.isFrozen(KERNEL_DEFAULTS));
  });
});

describe('KERNEL_CAP', () => {
  it('has all capability tags', () => {
    assert.equal(KERNEL_CAP.NET, 'net');
    assert.equal(KERNEL_CAP.FS, 'fs');
    assert.equal(KERNEL_CAP.CLOCK, 'clock');
    assert.equal(KERNEL_CAP.RNG, 'rng');
    assert.equal(KERNEL_CAP.IPC, 'ipc');
    assert.equal(KERNEL_CAP.STDIO, 'stdio');
    assert.equal(KERNEL_CAP.TRACE, 'trace');
    assert.equal(KERNEL_CAP.CHAOS, 'chaos');
    assert.equal(KERNEL_CAP.ENV, 'env');
    assert.equal(KERNEL_CAP.SIGNAL, 'signal');
    assert.equal(KERNEL_CAP.ALL, '*');
  });

  it('is frozen', () => {
    assert.ok(Object.isFrozen(KERNEL_CAP));
  });
});

describe('KERNEL_ERROR', () => {
  it('has all error codes', () => {
    assert.equal(KERNEL_ERROR.ENOHANDLE, 'ENOHANDLE');
    assert.equal(KERNEL_ERROR.EHANDLETYPE, 'EHANDLETYPE');
    assert.equal(KERNEL_ERROR.ETABLEFULL, 'ETABLEFULL');
    assert.equal(KERNEL_ERROR.ESTREAMCLOSED, 'ESTREAMCLOSED');
    assert.equal(KERNEL_ERROR.ECAPDENIED, 'ECAPDENIED');
    assert.equal(KERNEL_ERROR.EALREADY, 'EALREADY');
    assert.equal(KERNEL_ERROR.ENOTFOUND, 'ENOTFOUND');
    assert.equal(KERNEL_ERROR.ESIGNAL, 'ESIGNAL');
  });

  it('is frozen', () => {
    assert.ok(Object.isFrozen(KERNEL_ERROR));
  });
});
