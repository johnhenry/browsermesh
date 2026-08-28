import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Environment } from '../src/env.mjs';

describe('Environment', () => {
  it('get returns value', () => {
    const env = new Environment({ HOME: '/home/user', SHELL: '/bin/bash' });
    assert.equal(env.get('HOME'), '/home/user');
    assert.equal(env.get('SHELL'), '/bin/bash');
  });

  it('get returns undefined for missing key', () => {
    const env = new Environment({ HOME: '/home/user' });
    assert.equal(env.get('MISSING'), undefined);
  });

  it('has returns true/false', () => {
    const env = new Environment({ HOME: '/home/user' });
    assert.equal(env.has('HOME'), true);
    assert.equal(env.has('MISSING'), false);
  });

  it('all returns frozen object', () => {
    const env = new Environment({ A: '1', B: '2' });
    const all = env.all();
    assert.equal(all.A, '1');
    assert.equal(all.B, '2');
    assert.ok(Object.isFrozen(all));
  });

  it('size returns count', () => {
    const env = new Environment({ A: '1', B: '2', C: '3' });
    assert.equal(env.size, 3);
  });

  it('empty environment', () => {
    const env = new Environment();
    assert.equal(env.size, 0);
    assert.equal(env.get('any'), undefined);
  });

  it('original object is not mutated', () => {
    const original = { KEY: 'val' };
    const env = new Environment(original);
    original.KEY = 'changed';
    assert.equal(env.get('KEY'), 'val');
  });
});
