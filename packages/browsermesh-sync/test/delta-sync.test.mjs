import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  DeltaEntry,
  DeltaLog,
  DeltaEncoder,
  DeltaDecoder,
  DeltaBranch,
  SyncSession,
  SyncCoordinator,
  DELTA_SYNC_REQUEST,
  DELTA_SYNC_RESPONSE,
  DELTA_SYNC_ACK,
  DELTA_FULL_SNAPSHOT,
  DELTA_BRANCH_CREATE,
  DELTA_BRANCH_MERGE,
} from '../src/delta-sync.mjs';

// ---------------------------------------------------------------------------
// Wire constants
// ---------------------------------------------------------------------------

describe('Wire constants', () => {
  it('has correct hex values', () => {
    assert.equal(DELTA_SYNC_REQUEST, 0xE0);
    assert.equal(DELTA_SYNC_RESPONSE, 0xE1);
    assert.equal(DELTA_SYNC_ACK, 0xE2);
    assert.equal(DELTA_FULL_SNAPSHOT, 0xE3);
  });
});

// ---------------------------------------------------------------------------
// DeltaEntry
// ---------------------------------------------------------------------------

describe('DeltaEntry', () => {
  it('requires key', () => {
    assert.throws(() => new DeltaEntry({ op: 'set', origin: 'a' }), /key/);
  });

  it('requires valid op', () => {
    assert.throws(() => new DeltaEntry({ key: 'k', op: 'invalid', origin: 'a' }), /op/);
  });

  it('requires origin', () => {
    assert.throws(() => new DeltaEntry({ key: 'k', op: 'set' }), /origin/);
  });

  it('sets defaults', () => {
    const e = new DeltaEntry({ key: 'color', op: 'set', value: 'red', origin: 'podA' });
    assert.ok(e.id.startsWith('delta_'));
    assert.equal(e.key, 'color');
    assert.equal(e.op, 'set');
    assert.equal(e.value, 'red');
    assert.ok(e.timestamp > 0);
    assert.ok(e.seq > 0);
  });

  it('delete entries have undefined value', () => {
    const e = new DeltaEntry({ key: 'x', op: 'delete', origin: 'a', value: 'ignored' });
    assert.equal(e.value, undefined);
  });

  it('toJSON / fromJSON round-trips', () => {
    const e = new DeltaEntry({ key: 'k', op: 'set', value: 42, origin: 'podA', vectorClock: { podA: 1 } });
    const json = e.toJSON();
    const restored = DeltaEntry.fromJSON(json);
    assert.equal(restored.key, 'k');
    assert.equal(restored.op, 'set');
    assert.equal(restored.value, 42);
    assert.equal(restored.origin, 'podA');
    assert.deepEqual(restored.vectorClock, { podA: 1 });
  });

  it('toJSON omits value for delete ops', () => {
    const e = new DeltaEntry({ key: 'k', op: 'delete', origin: 'a' });
    const json = e.toJSON();
    assert.equal('value' in json, false);
  });
});

// ---------------------------------------------------------------------------
// DeltaLog
// ---------------------------------------------------------------------------

describe('DeltaLog', () => {
  let log;

  beforeEach(() => {
    log = new DeltaLog();
  });

  it('starts empty', () => {
    assert.equal(log.length, 0);
  });

  it('append() adds entries', () => {
    log.append(new DeltaEntry({ key: 'a', op: 'set', value: 1, origin: 'p1', seq: 1 }));
    log.append(new DeltaEntry({ key: 'b', op: 'set', value: 2, origin: 'p1', seq: 2 }));
    assert.equal(log.length, 2);
  });

  it('since() filters by sequence number', () => {
    log.append(new DeltaEntry({ key: 'a', op: 'set', value: 1, origin: 'p1', seq: 1 }));
    log.append(new DeltaEntry({ key: 'b', op: 'set', value: 2, origin: 'p1', seq: 2 }));
    log.append(new DeltaEntry({ key: 'c', op: 'set', value: 3, origin: 'p1', seq: 3 }));
    const result = log.since(1);
    assert.equal(result.length, 2);
    assert.equal(result[0].key, 'b');
  });

  it('sinceVectorClock() filters by vector clock', () => {
    log.append(new DeltaEntry({ key: 'a', op: 'set', value: 1, origin: 'p1', seq: 1 }));
    log.append(new DeltaEntry({ key: 'b', op: 'set', value: 2, origin: 'p2', seq: 1 }));
    log.append(new DeltaEntry({ key: 'c', op: 'set', value: 3, origin: 'p1', seq: 2 }));
    const result = log.sinceVectorClock({ p1: 1 }); // knows p1 up to seq 1
    assert.equal(result.length, 2); // p2:1 and p1:2
  });

  it('compact() keeps only latest per key', () => {
    log.append(new DeltaEntry({ key: 'a', op: 'set', value: 1, origin: 'p1', seq: 1 }));
    log.append(new DeltaEntry({ key: 'a', op: 'set', value: 2, origin: 'p1', seq: 2 }));
    log.append(new DeltaEntry({ key: 'b', op: 'set', value: 3, origin: 'p1', seq: 3 }));
    const removed = log.compact();
    assert.equal(removed, 1); // removed first 'a'
    assert.equal(log.length, 2);
    assert.equal(log.getLatest('a').value, 2);
  });

  it('auto-compacts when maxSize exceeded', () => {
    const smallLog = new DeltaLog({ maxSize: 3 });
    smallLog.append(new DeltaEntry({ key: 'a', op: 'set', value: 1, origin: 'p', seq: 1 }));
    smallLog.append(new DeltaEntry({ key: 'a', op: 'set', value: 2, origin: 'p', seq: 2 }));
    smallLog.append(new DeltaEntry({ key: 'b', op: 'set', value: 3, origin: 'p', seq: 3 }));
    smallLog.append(new DeltaEntry({ key: 'a', op: 'set', value: 4, origin: 'p', seq: 4 }));
    assert.ok(smallLog.length <= 3);
  });

  it('getLatest() finds latest entry for key', () => {
    log.append(new DeltaEntry({ key: 'x', op: 'set', value: 1, origin: 'p', seq: 1 }));
    log.append(new DeltaEntry({ key: 'x', op: 'set', value: 2, origin: 'p', seq: 2 }));
    assert.equal(log.getLatest('x').value, 2);
    assert.equal(log.getLatest('nonexistent'), null);
  });

  it('getMaxSeq() returns highest seq', () => {
    log.append(new DeltaEntry({ key: 'a', op: 'set', value: 1, origin: 'p', seq: 5 }));
    log.append(new DeltaEntry({ key: 'b', op: 'set', value: 2, origin: 'p', seq: 3 }));
    assert.equal(log.getMaxSeq(), 5);
  });

  it('getVectorClock() builds clock from entries', () => {
    log.append(new DeltaEntry({ key: 'a', op: 'set', value: 1, origin: 'p1', seq: 2 }));
    log.append(new DeltaEntry({ key: 'b', op: 'set', value: 2, origin: 'p2', seq: 3 }));
    log.append(new DeltaEntry({ key: 'c', op: 'set', value: 3, origin: 'p1', seq: 1 }));
    const vc = log.getVectorClock();
    assert.equal(vc.p1, 2);
    assert.equal(vc.p2, 3);
  });

  it('clear() empties the log', () => {
    log.append(new DeltaEntry({ key: 'a', op: 'set', value: 1, origin: 'p', seq: 1 }));
    log.clear();
    assert.equal(log.length, 0);
  });

  it('toJSON / fromJSON round-trips', () => {
    log.append(new DeltaEntry({ key: 'a', op: 'set', value: 1, origin: 'p1', seq: 1 }));
    const restored = DeltaLog.fromJSON(log.toJSON());
    assert.equal(restored.length, 1);
    assert.equal(restored.getLatest('a').value, 1);
  });
});

// ---------------------------------------------------------------------------
// DeltaEncoder
// ---------------------------------------------------------------------------

describe('DeltaEncoder', () => {
  let encoder;

  beforeEach(() => {
    encoder = new DeltaEncoder();
  });

  it('requires origin', () => {
    assert.throws(() => encoder.encode({}, {}, ''), /origin/);
  });

  it('detects new keys as set ops', () => {
    const deltas = encoder.encode({}, { color: 'red' }, 'podA');
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].op, 'set');
    assert.equal(deltas[0].key, 'color');
    assert.equal(deltas[0].value, 'red');
  });

  it('detects removed keys as delete ops', () => {
    const deltas = encoder.encode({ color: 'red' }, {}, 'podA');
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].op, 'delete');
    assert.equal(deltas[0].key, 'color');
  });

  it('detects changed primitive values as set ops', () => {
    const deltas = encoder.encode({ count: 1 }, { count: 2 }, 'podA');
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].op, 'set');
    assert.equal(deltas[0].value, 2);
  });

  it('detects changed object values as merge ops', () => {
    const deltas = encoder.encode(
      { config: { a: 1 } },
      { config: { a: 1, b: 2 } },
      'podA',
    );
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].op, 'merge');
  });

  it('skips unchanged keys', () => {
    const deltas = encoder.encode({ x: 1, y: 2 }, { x: 1, y: 2 }, 'podA');
    assert.equal(deltas.length, 0);
  });

  it('handles multiple changes', () => {
    const deltas = encoder.encode(
      { a: 1, b: 2, c: 3 },
      { a: 1, b: 99, d: 4 },
      'podA',
    );
    assert.equal(deltas.length, 3); // b changed, c deleted, d added
  });

  it('estimateSize() returns byte estimate', () => {
    const deltas = encoder.encode({}, { x: 1 }, 'podA');
    const size = encoder.estimateSize(deltas);
    assert.ok(size > 0);
  });
});

// ---------------------------------------------------------------------------
// DeltaDecoder
// ---------------------------------------------------------------------------

describe('DeltaDecoder', () => {
  let decoder;

  beforeEach(() => {
    decoder = new DeltaDecoder();
  });

  it('applies set operations', () => {
    const state = {};
    const entries = [new DeltaEntry({ key: 'x', op: 'set', value: 42, origin: 'p' })];
    decoder.apply(state, entries);
    assert.equal(state.x, 42);
  });

  it('applies delete operations', () => {
    const state = { x: 1, y: 2 };
    const entries = [new DeltaEntry({ key: 'x', op: 'delete', origin: 'p' })];
    decoder.apply(state, entries);
    assert.equal('x' in state, false);
    assert.equal(state.y, 2);
  });

  it('applies merge operations', () => {
    const state = { config: { a: 1, b: 2 } };
    const entries = [new DeltaEntry({ key: 'config', op: 'merge', value: { b: 99, c: 3 }, origin: 'p' })];
    decoder.apply(state, entries);
    assert.equal(state.config.a, 1);
    assert.equal(state.config.b, 99);
    assert.equal(state.config.c, 3);
  });

  it('merge on non-object does a set', () => {
    const state = { x: 42 };
    const entries = [new DeltaEntry({ key: 'x', op: 'merge', value: { a: 1 }, origin: 'p' })];
    decoder.apply(state, entries);
    assert.deepEqual(state.x, { a: 1 });
  });

  it('returns same state reference', () => {
    const state = {};
    const result = decoder.apply(state, []);
    assert.equal(result, state);
  });

  it('applyCausal() sorts by timestamp', () => {
    const state = { x: 0 };
    const entries = [
      new DeltaEntry({ key: 'x', op: 'set', value: 2, origin: 'p2', timestamp: 200, seq: 2 }),
      new DeltaEntry({ key: 'x', op: 'set', value: 1, origin: 'p1', timestamp: 100, seq: 1 }),
      new DeltaEntry({ key: 'x', op: 'set', value: 3, origin: 'p3', timestamp: 300, seq: 3 }),
    ];
    decoder.applyCausal(state, entries);
    assert.equal(state.x, 3); // last timestamp wins
  });

  it('throws on unknown op', () => {
    const state = {};
    const bad = new DeltaEntry({ key: 'x', op: 'set', origin: 'p' });
    bad.op = 'bad'; // force invalid
    assert.throws(() => decoder.apply(state, [bad]), /Unknown delta op/);
  });
});

// ---------------------------------------------------------------------------
// SyncSession
// ---------------------------------------------------------------------------

describe('SyncSession', () => {
  let session, log, decoder;

  beforeEach(() => {
    session = new SyncSession({ localPodId: 'podA', remotePodId: 'podB' });
    log = new DeltaLog();
    decoder = new DeltaDecoder();
  });

  it('requires localPodId', () => {
    assert.throws(() => new SyncSession({ remotePodId: 'b' }), /localPodId/);
  });

  it('requires remotePodId', () => {
    assert.throws(() => new SyncSession({ localPodId: 'a' }), /remotePodId/);
  });

  it('starts in idle state', () => {
    assert.equal(session.state, 'idle');
  });

  it('prepareSend() returns deltas from log', () => {
    log.append(new DeltaEntry({ key: 'x', op: 'set', value: 1, origin: 'podA', seq: 1 }));
    const deltas = session.prepareSend(log);
    assert.equal(deltas.length, 1);
    assert.equal(session.state, 'requesting');
  });

  it('confirmSent() updates remote clock', () => {
    log.append(new DeltaEntry({ key: 'x', op: 'set', value: 1, origin: 'podA', seq: 5 }));
    const deltas = session.prepareSend(log);
    session.confirmSent(deltas);
    assert.equal(session.remoteClock.podA, 5);
    assert.equal(session.stats.sent, 1);
  });

  it('receiveDeltas() and applyReceived() update local state', () => {
    const entries = [new DeltaEntry({ key: 'y', op: 'set', value: 42, origin: 'podB', seq: 1, timestamp: 100 })];
    session.receiveDeltas(entries);
    assert.equal(session.state, 'receiving');

    const state = {};
    session.applyReceived(state, decoder);
    assert.equal(state.y, 42);
    assert.equal(session.state, 'complete');
    assert.equal(session.stats.received, 1);
    assert.equal(session.stats.rounds, 1);
  });

  it('fires state change listeners', () => {
    const states = [];
    session.onStateChange(s => states.push(s));
    log.append(new DeltaEntry({ key: 'x', op: 'set', value: 1, origin: 'podA', seq: 1 }));
    session.prepareSend(log);
    assert.ok(states.includes('requesting'));
  });

  it('toJSON() serializes', () => {
    const json = session.toJSON();
    assert.equal(json.localPodId, 'podA');
    assert.equal(json.remotePodId, 'podB');
    assert.equal(json.state, 'idle');
  });
});

// ---------------------------------------------------------------------------
// SyncCoordinator
// ---------------------------------------------------------------------------

describe('SyncCoordinator', () => {
  let coordinator;

  beforeEach(() => {
    coordinator = new SyncCoordinator({ localPodId: 'podA' });
  });

  it('requires localPodId', () => {
    assert.throws(() => new SyncCoordinator({}), /localPodId/);
  });

  it('set() updates local state and log', () => {
    coordinator.set('color', 'red');
    assert.equal(coordinator.state.color, 'red');
    assert.equal(coordinator.getLog().length, 1);
  });

  it('delete() removes from state and adds to log', () => {
    coordinator.set('x', 1);
    coordinator.delete('x');
    assert.equal('x' in coordinator.state, false);
    assert.equal(coordinator.getLog().length, 2);
  });

  it('prepareSyncTo() returns deltas for remote', () => {
    coordinator.set('a', 1);
    coordinator.set('b', 2);
    const deltas = coordinator.prepareSyncTo('podB');
    assert.equal(deltas.length, 2);
  });

  it('receiveFrom() applies remote deltas', () => {
    const entries = [
      new DeltaEntry({ key: 'remote_key', op: 'set', value: 'hello', origin: 'podB', seq: 1, timestamp: 100 }),
    ];
    coordinator.receiveFrom('podB', entries);
    assert.equal(coordinator.state.remote_key, 'hello');
  });

  it('full sync round-trip between two coordinators', () => {
    const coordA = new SyncCoordinator({ localPodId: 'podA' });
    const coordB = new SyncCoordinator({ localPodId: 'podB' });

    // A makes changes
    coordA.set('theme', 'dark');
    coordA.set('lang', 'en');

    // A sends to B
    const deltasToB = coordA.prepareSyncTo('podB');
    coordB.receiveFrom('podA', deltasToB);

    assert.equal(coordB.state.theme, 'dark');
    assert.equal(coordB.state.lang, 'en');

    // B makes changes
    coordB.set('volume', 80);

    // B sends to A
    const deltasToA = coordB.prepareSyncTo('podA');
    coordA.receiveFrom('podB', deltasToA);

    assert.equal(coordA.state.volume, 80);
  });

  it('getSession() creates session on demand', () => {
    const session = coordinator.getSession('podB');
    assert.equal(session.remotePodId, 'podB');
    // Same session returned on second call
    assert.equal(coordinator.getSession('podB'), session);
  });

  it('removeSession() deletes session', () => {
    coordinator.getSession('podB');
    coordinator.removeSession('podB');
    assert.equal(coordinator.listSessions().length, 0);
  });

  it('listSessions() shows active sessions', () => {
    coordinator.getSession('podB');
    coordinator.getSession('podC');
    assert.equal(coordinator.listSessions().length, 2);
  });

  it('onSync() fires on receive', () => {
    const synced = [];
    coordinator.onSync((podId, entries) => synced.push({ podId, count: entries.length }));
    coordinator.receiveFrom('podB', [
      new DeltaEntry({ key: 'x', op: 'set', value: 1, origin: 'podB', seq: 1, timestamp: 100 }),
    ]);
    assert.equal(synced.length, 1);
    assert.equal(synced[0].podId, 'podB');
  });

  it('getStats() provides summary', () => {
    coordinator.set('a', 1);
    coordinator.receiveFrom('podB', [
      new DeltaEntry({ key: 'b', op: 'set', value: 2, origin: 'podB', seq: 1, timestamp: 100 }),
    ]);
    const stats = coordinator.getStats();
    assert.equal(stats.sessionCount, 1);
    assert.ok(stats.logSize >= 2);
    assert.equal(stats.stateKeys, 2);
  });

  it('toJSON() serializes', () => {
    coordinator.set('x', 1);
    const json = coordinator.toJSON();
    assert.equal(json.localPodId, 'podA');
    assert.equal(json.state.x, 1);
    assert.ok(Array.isArray(json.log));
  });
});

// ---------------------------------------------------------------------------
// Wire constants (branch)
// ---------------------------------------------------------------------------

describe('Branch wire constants', () => {
  it('has correct hex values', () => {
    assert.equal(DELTA_BRANCH_CREATE, 0xE4);
    assert.equal(DELTA_BRANCH_MERGE, 0xE5);
  });
});

// ---------------------------------------------------------------------------
// DeltaBranch
// ---------------------------------------------------------------------------

describe('DeltaBranch', () => {
  it('constructor requires name', () => {
    assert.throws(() => new DeltaBranch('', {}), /Branch name is required/);
    assert.throws(() => new DeltaBranch(null, {}), /Branch name is required/);
  });

  it('apply adds entries to branch log', () => {
    const branch = new DeltaBranch('feature', { x: 1 });
    branch.apply('y', 2);
    branch.apply('z', 3);
    assert.equal(branch.logSize, 2);
  });

  it('delete adds delete entries', () => {
    const branch = new DeltaBranch('feature', { x: 1, y: 2 });
    branch.delete('x');
    assert.equal(branch.logSize, 1);
    const state = branch.getState();
    assert.equal('x' in state, false);
    assert.equal(state.y, 2);
  });

  it('getState returns snapshot + applied deltas', () => {
    const branch = new DeltaBranch('feature', { a: 1, b: 2 });
    branch.apply('b', 99);
    branch.apply('c', 3);
    const state = branch.getState();
    assert.equal(state.a, 1);
    assert.equal(state.b, 99);
    assert.equal(state.c, 3);
  });

  it('diffFrom detects changed keys', () => {
    const branchA = new DeltaBranch('a', { x: 1, y: 2 });
    branchA.apply('x', 10);

    const branchB = new DeltaBranch('b', { x: 1, y: 2 });
    branchB.apply('y', 20);

    const diff = branchA.diffFrom(branchB);
    assert.equal(diff.length, 2);
    const xDiff = diff.find(d => d.key === 'x');
    assert.equal(xDiff.ours, 10);
    assert.equal(xDiff.theirs, 1);
    const yDiff = diff.find(d => d.key === 'y');
    assert.equal(yDiff.ours, 2);
    assert.equal(yDiff.theirs, 20);
  });

  it('toJSON serializes correctly', () => {
    const branch = new DeltaBranch('feature', { a: 1 }, 'main');
    branch.apply('b', 2);
    const json = branch.toJSON();
    assert.equal(json.name, 'feature');
    assert.deepEqual(json.snapshot, { a: 1 });
    assert.equal(json.parentBranch, 'main');
    assert.ok(Array.isArray(json.log));
    assert.equal(json.log.length, 1);
    assert.ok(json.createdAt > 0);
  });
});

// ---------------------------------------------------------------------------
// SyncCoordinator Branching
// ---------------------------------------------------------------------------

describe('SyncCoordinator Branching', () => {
  let coordinator;

  beforeEach(() => {
    coordinator = new SyncCoordinator({ localPodId: 'podA', initialState: { x: 1, y: 2 } });
  });

  it('createBranch creates a branch with current state snapshot', () => {
    const branch = coordinator.createBranch('feature');
    assert.equal(branch.name, 'feature');
    const branchState = branch.getState();
    assert.equal(branchState.x, 1);
    assert.equal(branchState.y, 2);
  });

  it('createBranch throws on duplicate name', () => {
    coordinator.createBranch('feature');
    assert.throws(() => coordinator.createBranch('feature'), /already exists/);
  });

  it('listBranches returns branch metadata', () => {
    coordinator.createBranch('feature');
    coordinator.createBranch('experiment');
    const list = coordinator.listBranches();
    assert.equal(list.length, 2);
    const names = list.map(b => b.name);
    assert.ok(names.includes('feature'));
    assert.ok(names.includes('experiment'));
    assert.ok(list[0].createdAt > 0);
    assert.equal(list[0].logSize, 0);
  });

  it('switchBranch applies branch state', () => {
    const branch = coordinator.createBranch('feature');
    branch.apply('x', 99);
    branch.apply('z', 3);

    const newState = coordinator.switchBranch('feature');
    assert.equal(newState.x, 99);
    assert.equal(newState.y, 2);
    assert.equal(newState.z, 3);
    // Coordinator state should also reflect the switch
    assert.equal(coordinator.state.x, 99);
  });

  it('switchBranch throws on nonexistent branch', () => {
    assert.throws(() => coordinator.switchBranch('nope'), /does not exist/);
  });

  it('mergeBranch with theirs uses branch values', () => {
    coordinator.createBranch('feature');
    // Modify branch
    const branch = coordinator.listBranches().find(b => b.name === 'feature');
    assert.ok(branch);

    // Use createBranch return value to modify
    const coord2 = new SyncCoordinator({ localPodId: 'podA', initialState: { x: 1, y: 2 } });
    const b = coord2.createBranch('feature');
    b.apply('x', 99);
    b.apply('z', 3);

    // Modify main state so there is a conflict
    coord2.set('x', 50);

    const result = coord2.mergeBranch('feature', 'theirs');
    assert.ok(result.merged > 0);
    assert.equal(coord2.state.x, 99);
    assert.equal(coord2.state.z, 3);
    // Branch should be deleted after merge
    assert.equal(coord2.listBranches().length, 0);
  });

  it('mergeBranch with fail throws on conflicts', () => {
    const b = coordinator.createBranch('feature');
    b.apply('x', 99);
    coordinator.set('x', 50);

    assert.throws(() => coordinator.mergeBranch('feature', 'fail'), /Merge conflict/);
  });

  it('deleteBranch removes the branch', () => {
    coordinator.createBranch('feature');
    assert.equal(coordinator.listBranches().length, 1);
    const result = coordinator.deleteBranch('feature');
    assert.equal(result, true);
    assert.equal(coordinator.listBranches().length, 0);
  });

  it('deleteBranch returns false for nonexistent branch', () => {
    assert.equal(coordinator.deleteBranch('nope'), false);
  });
});

// ---------------------------------------------------------------------------
// SyncCoordinator wire protocol
// ---------------------------------------------------------------------------

describe('SyncCoordinator wire protocol', () => {
  let coordinator;
  let sent;
  let sendFn;

  beforeEach(() => {
    sent = [];
    sendFn = (targetId, msg) => sent.push({ targetId, msg });
    coordinator = new SyncCoordinator({ localPodId: 'podA', sendFn });
  });

  it('handleMessage DELTA_SYNC_REQUEST sends response with entries', () => {
    coordinator.set('x', 1);
    coordinator.handleMessage('podB', { type: DELTA_SYNC_REQUEST });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].targetId, 'podB');
    assert.equal(sent[0].msg.type, DELTA_SYNC_RESPONSE);
    assert.ok(Array.isArray(sent[0].msg.entries));
    assert.ok(sent[0].msg.entries.length > 0);
  });

  it('handleMessage DELTA_SYNC_RESPONSE applies entries and sends ack', () => {
    const entry = new DeltaEntry({ key: 'remote', op: 'set', value: 42, origin: 'podB', seq: 1, timestamp: 100 });
    coordinator.handleMessage('podB', { type: DELTA_SYNC_RESPONSE, entries: [entry.toJSON()] });
    assert.equal(coordinator.state.remote, 42);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].msg.type, DELTA_SYNC_ACK);
  });

  it('handleMessage DELTA_SYNC_ACK confirms sent on session', () => {
    coordinator.set('x', 1);
    // Prepare a send so the session has pending data
    coordinator.prepareSyncTo('podB');
    const entry = new DeltaEntry({ key: 'x', op: 'set', value: 1, origin: 'podA', seq: 1 });
    coordinator.handleMessage('podB', { type: DELTA_SYNC_ACK, entries: [entry.toJSON()] });
    const session = coordinator.getSession('podB');
    assert.ok(session.stats.sent > 0);
  });

  it('handleMessage DELTA_FULL_SNAPSHOT applies full state replace', () => {
    coordinator.set('old', 'val');
    coordinator.handleMessage('podB', { type: DELTA_FULL_SNAPSHOT, state: { newKey: 'newVal' } });
    assert.equal(coordinator.state.newKey, 'newVal');
    assert.equal(coordinator.state.old, undefined);
  });

  it('handleMessage DELTA_FULL_SNAPSHOT sends own state when no msg.state', () => {
    coordinator.set('x', 99);
    coordinator.handleMessage('podB', { type: DELTA_FULL_SNAPSHOT });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].msg.type, DELTA_FULL_SNAPSHOT);
    assert.equal(sent[0].msg.state.x, 99);
  });

  it('handleMessage DELTA_BRANCH_CREATE creates branch', () => {
    coordinator.handleMessage('podB', { type: DELTA_BRANCH_CREATE, name: 'feature' });
    assert.equal(coordinator.listBranches().length, 1);
    assert.equal(coordinator.listBranches()[0].name, 'feature');
  });

  it('handleMessage DELTA_BRANCH_MERGE merges branch', () => {
    coordinator.createBranch('feature');
    coordinator.handleMessage('podB', { type: DELTA_BRANCH_MERGE, name: 'feature', strategy: 'ours' });
    assert.equal(coordinator.listBranches().length, 0);
  });

  it('requestSync sends DELTA_SYNC_REQUEST via sendFn', () => {
    coordinator.requestSync('podC');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].targetId, 'podC');
    assert.equal(sent[0].msg.type, DELTA_SYNC_REQUEST);
  });

  it('broadcastState sends DELTA_FULL_SNAPSHOT to all peers', () => {
    coordinator.set('theme', 'dark');
    coordinator.broadcastState(['podB', 'podC']);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].msg.type, DELTA_FULL_SNAPSHOT);
    assert.equal(sent[0].msg.state.theme, 'dark');
    assert.equal(sent[1].targetId, 'podC');
  });

  it('unknown msg.type is ignored without error', () => {
    coordinator.handleMessage('podB', { type: 0xFF });
    assert.equal(sent.length, 0);
  });

  it('works without sendFn (graceful no-op)', () => {
    const noSend = new SyncCoordinator({ localPodId: 'podX' });
    noSend.set('a', 1);
    // handleMessage should not throw even without sendFn
    noSend.handleMessage('podB', { type: DELTA_SYNC_REQUEST });
    noSend.handleMessage('podB', { type: DELTA_FULL_SNAPSHOT });
    noSend.requestSync('podB');
    noSend.broadcastState(['podB', 'podC']);
  });

  it('handleMessage DELTA_SYNC_RESPONSE with missing entries defaults to empty', () => {
    // Should not throw when entries is undefined
    coordinator.handleMessage('podB', { type: DELTA_SYNC_RESPONSE });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].msg.type, DELTA_SYNC_ACK);
  });
});
