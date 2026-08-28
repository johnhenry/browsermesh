import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SIGNAL, SignalController } from '../src/signal.mjs';

describe('SIGNAL', () => {
  it('has expected values', () => {
    assert.equal(SIGNAL.TERM, 'TERM');
    assert.equal(SIGNAL.INT, 'INT');
    assert.equal(SIGNAL.HUP, 'HUP');
  });

  it('is frozen', () => {
    assert.ok(Object.isFrozen(SIGNAL));
  });
});

describe('SignalController', () => {
  it('signal fires registered callbacks', () => {
    const sc = new SignalController();
    const fired = [];
    sc.onSignal(SIGNAL.TERM, () => fired.push('term'));
    sc.signal(SIGNAL.TERM);
    assert.deepEqual(fired, ['term']);
  });

  it('hasFired returns true after signal', () => {
    const sc = new SignalController();
    assert.equal(sc.hasFired(SIGNAL.TERM), false);
    sc.signal(SIGNAL.TERM);
    assert.equal(sc.hasFired(SIGNAL.TERM), true);
  });

  it('unsubscribe removes callback', () => {
    const sc = new SignalController();
    const fired = [];
    const unsub = sc.onSignal(SIGNAL.TERM, () => fired.push('x'));
    unsub();
    sc.signal(SIGNAL.TERM);
    assert.deepEqual(fired, []);
  });

  it('abortSignal aborts on signal', () => {
    const sc = new SignalController();
    const sig = sc.abortSignal(SIGNAL.INT);
    assert.equal(sig.aborted, false);
    sc.signal(SIGNAL.INT);
    assert.equal(sig.aborted, true);
  });

  it('abortSignal already fired', () => {
    const sc = new SignalController();
    sc.signal(SIGNAL.TERM);
    const sig = sc.abortSignal(SIGNAL.TERM);
    assert.equal(sig.aborted, true);
  });

  it('reset allows re-signaling', () => {
    const sc = new SignalController();
    sc.signal(SIGNAL.TERM);
    sc.reset(SIGNAL.TERM);
    assert.equal(sc.hasFired(SIGNAL.TERM), false);
    const sig = sc.abortSignal(SIGNAL.TERM);
    assert.equal(sig.aborted, false);
  });

  it('shutdownSignal aborts on TERM', () => {
    const sc = new SignalController();
    const sig = sc.shutdownSignal;
    assert.equal(sig.aborted, false);
    sc.signal(SIGNAL.TERM);
    assert.equal(sig.aborted, true);
  });

  it('shutdownSignal aborts on INT', () => {
    const sc = new SignalController();
    const sig = sc.shutdownSignal;
    sc.signal(SIGNAL.INT);
    assert.equal(sig.aborted, true);
  });

  it('multiple callbacks for same signal', () => {
    const sc = new SignalController();
    const fired = [];
    sc.onSignal(SIGNAL.HUP, () => fired.push('a'));
    sc.onSignal(SIGNAL.HUP, () => fired.push('b'));
    sc.signal(SIGNAL.HUP);
    assert.deepEqual(fired, ['a', 'b']);
  });
});
