import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { silentCatch, refreshSilentCatchState } from '../src/silent-catch.mjs';

function withStorage(store) {
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
}

function capture(fn) {
  const calls = [];
  const orig = console.warn;
  console.warn = (...a) => calls.push(a);
  try { fn(); } finally { console.warn = orig; }
  return calls;
}

describe('silent-catch debug switch', () => {
  afterEach(() => {
    delete globalThis.localStorage;
    refreshSilentCatchState();
  });

  it('is silent by default', () => {
    withStorage({});
    refreshSilentCatchState();
    assert.equal(capture(() => silentCatch('m', 'op', new Error('x'))).length, 0);
  });

  it('browsermesh_debug enables logging', () => {
    withStorage({ browsermesh_debug: 'true' });
    refreshSilentCatchState();
    const calls = capture(() => silentCatch('m', 'op', new Error('x')));
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], '[browsermesh:silent-catch]');
  });

  it('deprecated clawser_debug alias still enables logging', () => {
    withStorage({ clawser_debug: 'true' });
    refreshSilentCatchState();
    assert.equal(capture(() => silentCatch('m', 'op', new Error('x'))).length, 1);
  });

  it('both globals point at the same object', () => {
    assert.ok(globalThis.browsermeshDebug);
    assert.equal(globalThis.clawserDebug, globalThis.browsermeshDebug);
  });
});
