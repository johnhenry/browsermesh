import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { silentCatch, refreshSilentCatchState } from '../src/silent-catch.mjs';

function capture(fn) {
  const calls = [];
  const orig = console.warn;
  console.warn = (...args) => calls.push(args);
  try { fn(); } finally { console.warn = orig; }
  return calls;
}

describe('silentCatch debug switch', () => {
  afterEach(() => {
    localStorage.removeItem('browsermesh_debug');
    localStorage.removeItem('clawser_debug');
    refreshSilentCatchState();
  });

  it('is silent by default', () => {
    refreshSilentCatchState();
    assert.equal(capture(() => silentCatch('m', 'op', new Error('x'))).length, 0);
  });

  it('browsermesh_debug enables logging with the new prefix', () => {
    localStorage.setItem('browsermesh_debug', 'true');
    const calls = capture(() => silentCatch('m', 'op', new Error('x')));
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], '[browsermesh:silent-catch]');
  });

  it('deprecated clawser_debug alias still enables logging', () => {
    localStorage.setItem('clawser_debug', 'true');
    const calls = capture(() => silentCatch('m', 'op', new Error('x')));
    assert.equal(calls.length, 1);
  });
});
