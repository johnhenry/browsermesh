// Run with: node --import ./test/_setup-globals.mjs --test test/migration.test.mjs
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  MIGRATION_INIT,
  MIGRATION_CHECKPOINT,
  MIGRATION_TRANSFER,
  MIGRATION_ACTIVATE,
  MIGRATION_STATES,
  STEP_STATUSES,
  MIGRATION_PRIORITIES,
  DUAL_ACTIVE_STATES,
  MigrationStep,
  Checkpoint,
  MigrationPlan,
  DualActiveWindow,
  MigrationEngine,
} from '../src/migration.mjs';

// ── Wire Constants ───────────────────────────────────────────────────────────

describe('Wire constants', () => {
  it('MIGRATION_INIT is 0xA4', () => {
    assert.equal(MIGRATION_INIT, 0xA4);
  });

  it('MIGRATION_CHECKPOINT is 0xA5', () => {
    assert.equal(MIGRATION_CHECKPOINT, 0xA5);
  });

  it('MIGRATION_TRANSFER is 0xA6', () => {
    assert.equal(MIGRATION_TRANSFER, 0xA6);
  });

  it('MIGRATION_ACTIVATE is 0xA7', () => {
    assert.equal(MIGRATION_ACTIVATE, 0xA7);
  });

  it('all wire constants are distinct', () => {
    const vals = [MIGRATION_INIT, MIGRATION_CHECKPOINT, MIGRATION_TRANSFER, MIGRATION_ACTIVATE];
    assert.equal(new Set(vals).size, vals.length);
  });
});

// ── Frozen Enums ─────────────────────────────────────────────────────────────

describe('Frozen enums', () => {
  it('MIGRATION_STATES is frozen with 8 entries', () => {
    assert.ok(Object.isFrozen(MIGRATION_STATES));
    assert.equal(MIGRATION_STATES.length, 8);
  });

  it('STEP_STATUSES is frozen with 5 entries', () => {
    assert.ok(Object.isFrozen(STEP_STATUSES));
    assert.equal(STEP_STATUSES.length, 5);
  });

  it('MIGRATION_PRIORITIES is frozen with 2 entries', () => {
    assert.ok(Object.isFrozen(MIGRATION_PRIORITIES));
    assert.deepEqual([...MIGRATION_PRIORITIES], ['normal', 'urgent']);
  });

  it('DUAL_ACTIVE_STATES is frozen with 3 entries', () => {
    assert.ok(Object.isFrozen(DUAL_ACTIVE_STATES));
    assert.deepEqual([...DUAL_ACTIVE_STATES], ['inactive', 'active', 'ended']);
  });
});

// ── MigrationStep ────────────────────────────────────────────────────────────

describe('MigrationStep', () => {
  it('constructor sets name and defaults', () => {
    const step = new MigrationStep({ name: 'checkpoint' });
    assert.equal(step.name, 'checkpoint');
    assert.equal(step.status, 'pending');
    assert.equal(step.startedAt, null);
    assert.equal(step.completedAt, null);
    assert.equal(step.error, null);
  });

  it('constructor throws without name', () => {
    assert.throws(() => new MigrationStep({}), /name is required/);
  });

  it('start() sets status and startedAt', () => {
    const step = new MigrationStep({ name: 'transfer' });
    step.start();
    assert.equal(step.status, 'running');
    assert.equal(typeof step.startedAt, 'number');
  });

  it('complete() sets status and completedAt', () => {
    const step = new MigrationStep({ name: 'verify' });
    step.start();
    step.complete();
    assert.equal(step.status, 'completed');
    assert.equal(typeof step.completedAt, 'number');
  });

  it('fail() sets status, completedAt, and error', () => {
    const step = new MigrationStep({ name: 'activate' });
    step.start();
    step.fail('something broke');
    assert.equal(step.status, 'failed');
    assert.equal(step.error, 'something broke');
    assert.equal(typeof step.completedAt, 'number');
  });

  it('skip() sets status and completedAt', () => {
    const step = new MigrationStep({ name: 'activate' });
    step.skip();
    assert.equal(step.status, 'skipped');
    assert.equal(typeof step.completedAt, 'number');
  });

  it('toJSON / fromJSON round-trips', () => {
    const step = new MigrationStep({ name: 'transfer' });
    step.start();
    step.complete();
    const json = step.toJSON();
    const restored = MigrationStep.fromJSON(json);
    assert.equal(restored.name, 'transfer');
    assert.equal(restored.status, 'completed');
    assert.equal(restored.startedAt, step.startedAt);
    assert.equal(restored.completedAt, step.completedAt);
  });
});

// ── Checkpoint ───────────────────────────────────────────────────────────────

describe('Checkpoint', () => {
  /** @type {MigrationEngine} */
  let engine;

  beforeEach(() => {
    engine = new MigrationEngine('pod_source');
  });

  it('createCheckpoint produces a valid Checkpoint', async () => {
    const ckpt = await engine.createCheckpoint({ key: 'value', count: 42 });
    assert.ok(ckpt.checkpointId.startsWith('ckpt_'));
    assert.equal(ckpt.sourcePodId, 'pod_source');
    assert.deepEqual(ckpt.data, { key: 'value', count: 42 });
    assert.ok(ckpt.dataHash instanceof Uint8Array);
    assert.equal(ckpt.dataHash.length, 32); // SHA-256
    assert.equal(typeof ckpt.createdAt, 'number');
    assert.ok(ckpt.sizeBytes > 0);
  });

  it('verify() returns true for untampered data', async () => {
    const ckpt = await engine.createCheckpoint({ hello: 'world' });
    assert.equal(await ckpt.verify(), true);
  });

  it('verify() returns false for tampered data', async () => {
    const ckpt = await engine.createCheckpoint({ hello: 'world' });
    ckpt.data.hello = 'tampered';
    assert.equal(await ckpt.verify(), false);
  });

  it('toJSON / fromJSON round-trips', async () => {
    const ckpt = await engine.createCheckpoint({ x: 1 });
    const json = ckpt.toJSON();
    assert.doesNotThrow(() => JSON.stringify(json));
    assert.equal(typeof json.dataHash, 'string'); // hex string

    const restored = Checkpoint.fromJSON(json);
    assert.equal(restored.checkpointId, ckpt.checkpointId);
    assert.equal(restored.sourcePodId, ckpt.sourcePodId);
    assert.deepEqual(restored.data, ckpt.data);
    assert.ok(restored.dataHash instanceof Uint8Array);
    assert.equal(restored.dataHash.length, 32);
    assert.equal(await restored.verify(), true);
  });

  it('constructor throws without required fields', () => {
    assert.throws(() => new Checkpoint({
      sourcePodId: 'p', data: {}, dataHash: new Uint8Array(32), createdAt: 1, sizeBytes: 0,
    }), /checkpointId/);

    assert.throws(() => new Checkpoint({
      checkpointId: 'c', data: {}, dataHash: new Uint8Array(32), createdAt: 1, sizeBytes: 0,
    }), /sourcePodId/);

    assert.throws(() => new Checkpoint({
      checkpointId: 'c', sourcePodId: 'p', data: {}, dataHash: 'not-uint8', createdAt: 1, sizeBytes: 0,
    }), /Uint8Array/);
  });

  it('sizeBytes reflects serialized JSON length', async () => {
    const data = { a: 'hello', b: [1, 2, 3] };
    const ckpt = await engine.createCheckpoint(data);
    const expected = new TextEncoder().encode(JSON.stringify(data)).length;
    assert.equal(ckpt.sizeBytes, expected);
  });
});

// ── MigrationPlan ────────────────────────────────────────────────────────────

describe('MigrationPlan', () => {
  let plan;

  beforeEach(() => {
    plan = new MigrationPlan({
      migrationId: 'mig_test',
      sourcePodId: 'pod_a',
      targetPodId: 'pod_b',
    });
  });

  it('constructor sets fields and creates 4 default steps', () => {
    assert.equal(plan.migrationId, 'mig_test');
    assert.equal(plan.sourcePodId, 'pod_a');
    assert.equal(plan.targetPodId, 'pod_b');
    assert.equal(plan.priority, 'normal');
    assert.equal(plan.state, 'idle');
    assert.equal(plan.steps.length, 4);
    assert.equal(plan.currentStep, 0);
    assert.deepEqual(
      plan.steps.map(s => s.name),
      ['checkpoint', 'transfer', 'verify', 'activate'],
    );
  });

  it('constructor throws without required fields', () => {
    assert.throws(() => new MigrationPlan({ sourcePodId: 's', targetPodId: 't' }), /migrationId/);
    assert.throws(() => new MigrationPlan({ migrationId: 'm', targetPodId: 't' }), /sourcePodId/);
    assert.throws(() => new MigrationPlan({ migrationId: 'm', sourcePodId: 's' }), /targetPodId/);
  });

  it('constructor rejects invalid priority', () => {
    assert.throws(() => new MigrationPlan({
      migrationId: 'm', sourcePodId: 's', targetPodId: 't', priority: 'critical',
    }), /Invalid priority/);
  });

  it('advance() progresses through steps', () => {
    // Start first step manually
    plan.steps[0].start();
    plan.state = 'checkpointing';

    // Advance from checkpoint -> transfer
    const step = plan.advance();
    assert.equal(step.name, 'transfer');
    assert.equal(step.status, 'running');
    assert.equal(plan.currentStep, 1);
    assert.equal(plan.state, 'transferring');

    // Advance from transfer -> verify
    const step2 = plan.advance();
    assert.equal(step2.name, 'verify');
    assert.equal(plan.state, 'verifying');

    // Advance from verify -> activate
    const step3 = plan.advance();
    assert.equal(step3.name, 'activate');
    assert.equal(plan.state, 'activating');

    // Advance past the last step
    const step4 = plan.advance();
    assert.equal(step4, null);
    assert.equal(plan.state, 'completed');
  });

  it('fail() marks current step and plan as failed', () => {
    plan.steps[0].start();
    plan.fail('disk full');
    assert.equal(plan.steps[0].status, 'failed');
    assert.equal(plan.steps[0].error, 'disk full');
    assert.equal(plan.state, 'failed');
    assert.equal(plan.isFailed, true);
  });

  it('rollback() skips pending/running steps and sets state', () => {
    plan.steps[0].start();
    plan.steps[0].complete();
    plan.currentStep = 1;
    plan.steps[1].start();

    plan.rollback();

    assert.equal(plan.steps[0].status, 'completed'); // already done
    assert.equal(plan.steps[1].status, 'skipped');    // was running
    assert.equal(plan.steps[2].status, 'skipped');    // was pending
    assert.equal(plan.steps[3].status, 'skipped');    // was pending
    assert.equal(plan.state, 'rolledBack');
  });

  it('isComplete / isFailed reflect state', () => {
    assert.equal(plan.isComplete, false);
    assert.equal(plan.isFailed, false);
    plan.state = 'completed';
    assert.equal(plan.isComplete, true);
    plan.state = 'failed';
    assert.equal(plan.isFailed, true);
  });

  it('progress returns fraction 0-1', () => {
    assert.equal(plan.progress, 0);

    plan.steps[0].start();
    plan.steps[0].complete();
    assert.equal(plan.progress, 0.25);

    plan.steps[1].start();
    plan.steps[1].complete();
    assert.equal(plan.progress, 0.5);

    plan.steps[2].skip();
    assert.equal(plan.progress, 0.75);

    plan.steps[3].start();
    plan.steps[3].complete();
    assert.equal(plan.progress, 1);
  });

  it('toJSON / fromJSON round-trips', () => {
    plan.steps[0].start();
    plan.steps[0].complete();
    plan.currentStep = 1;
    plan.state = 'transferring';
    plan.reason = 'load balancing';
    plan.priority = 'urgent';

    const json = plan.toJSON();
    assert.doesNotThrow(() => JSON.stringify(json));

    const restored = MigrationPlan.fromJSON(json);
    assert.equal(restored.migrationId, 'mig_test');
    assert.equal(restored.sourcePodId, 'pod_a');
    assert.equal(restored.targetPodId, 'pod_b');
    assert.equal(restored.reason, 'load balancing');
    assert.equal(restored.priority, 'urgent');
    assert.equal(restored.state, 'transferring');
    assert.equal(restored.currentStep, 1);
    assert.equal(restored.steps.length, 4);
    assert.equal(restored.steps[0].status, 'completed');
    assert.equal(restored.steps[1].status, 'pending');
  });
});

// ── MigrationEngine ──────────────────────────────────────────────────────────

describe('MigrationEngine', () => {
  /** @type {MigrationEngine} */
  let engine;

  beforeEach(() => {
    engine = new MigrationEngine('pod_local', { maxConcurrent: 2, timeoutMs: 5000 });
  });

  it('constructor sets localPodId and options', () => {
    assert.equal(engine.localPodId, 'pod_local');
    assert.equal(engine.maxConcurrent, 2);
    assert.equal(engine.timeoutMs, 5000);
  });

  it('constructor throws without localPodId', () => {
    assert.throws(() => new MigrationEngine(), /localPodId is required/);
  });

  it('constructor uses defaults for opts', () => {
    const e = new MigrationEngine('p');
    assert.equal(e.maxConcurrent, 3);
    assert.equal(e.timeoutMs, 60_000);
  });

  describe('createCheckpoint()', () => {
    it('creates a checkpoint with valid hash', async () => {
      const ckpt = await engine.createCheckpoint({ state: 'active', items: [1, 2, 3] });
      assert.equal(ckpt.sourcePodId, 'pod_local');
      assert.ok(ckpt.checkpointId.startsWith('ckpt_'));
      assert.equal(await ckpt.verify(), true);
    });

    it('different data produces different hashes', async () => {
      const a = await engine.createCheckpoint({ x: 1 });
      const b = await engine.createCheckpoint({ x: 2 });
      assert.notDeepEqual(a.dataHash, b.dataHash);
    });
  });

  describe('initiateMigration()', () => {
    it('creates a plan in idle state', async () => {
      const ckpt = await engine.createCheckpoint({ data: true });
      const plan = engine.initiateMigration('pod_remote', ckpt, { reason: 'scaling' });
      assert.ok(plan.migrationId.startsWith('mig_'));
      assert.equal(plan.sourcePodId, 'pod_local');
      assert.equal(plan.targetPodId, 'pod_remote');
      assert.equal(plan.reason, 'scaling');
      assert.equal(plan.state, 'idle');
    });

    it('throws without targetPodId', async () => {
      const ckpt = await engine.createCheckpoint({});
      assert.throws(() => engine.initiateMigration('', ckpt), /targetPodId/);
    });

    it('throws without checkpoint', () => {
      assert.throws(() => engine.initiateMigration('pod_remote', null), /checkpoint/);
    });

    it('enforces maxConcurrent', async () => {
      const ckpt = await engine.createCheckpoint({});
      // Create 2 migrations and start them so they count as active
      const p1 = engine.initiateMigration('pod_r1', ckpt);
      const p2 = engine.initiateMigration('pod_r2', ckpt);
      // Start both into checkpointing state
      await engine.stepCheckpoint(p1);
      await engine.stepCheckpoint(p2);
      // Third should fail
      assert.throws(
        () => engine.initiateMigration('pod_r3', ckpt),
        /Max concurrent/,
      );
    });
  });

  describe('step functions', () => {
    let plan;
    let checkpoint;

    beforeEach(async () => {
      checkpoint = await engine.createCheckpoint({ test: 'data' });
      plan = engine.initiateMigration('pod_target', checkpoint);
    });

    it('stepCheckpoint succeeds with valid checkpoint', async () => {
      const result = await engine.stepCheckpoint(plan);
      assert.equal(result.steps[0].status, 'completed');
      assert.equal(result.state, 'checkpointing');
    });

    it('stepTransfer marks transfer complete', async () => {
      await engine.stepCheckpoint(plan);
      const result = await engine.stepTransfer(plan);
      assert.equal(result.steps[1].status, 'completed');
    });

    it('stepVerify succeeds with matching hash', async () => {
      await engine.stepCheckpoint(plan);
      await engine.stepTransfer(plan);
      const result = await engine.stepVerify(plan, checkpoint.dataHash);
      assert.equal(result.steps[2].status, 'completed');
      assert.equal(result.state, 'verifying');
    });

    it('stepVerify fails with mismatched hash', async () => {
      await engine.stepCheckpoint(plan);
      await engine.stepTransfer(plan);
      const badHash = new Uint8Array(32);
      const result = await engine.stepVerify(plan, badHash);
      assert.equal(result.steps[2].status, 'failed');
      assert.ok(result.steps[2].error.includes('mismatch'));
      assert.equal(result.state, 'failed');
    });

    it('stepVerify fails with non-Uint8Array hash', async () => {
      await engine.stepCheckpoint(plan);
      await engine.stepTransfer(plan);
      const result = await engine.stepVerify(plan, 'not-a-hash');
      assert.equal(result.steps[2].status, 'failed');
      assert.equal(result.state, 'failed');
    });

    it('stepActivate completes migration', async () => {
      await engine.stepCheckpoint(plan);
      await engine.stepTransfer(plan);
      await engine.stepVerify(plan, checkpoint.dataHash);
      const result = await engine.stepActivate(plan);
      assert.equal(result.steps[3].status, 'completed');
      assert.equal(result.state, 'completed');
    });
  });

  describe('executePlan()', () => {
    it('runs all steps to completion', async () => {
      const ckpt = await engine.createCheckpoint({ full: 'run' });
      const plan = engine.initiateMigration('pod_target', ckpt);
      const result = await engine.executePlan(plan);
      assert.equal(result.state, 'completed');
      assert.equal(result.isComplete, true);
      assert.equal(result.progress, 1);
      for (const step of result.steps) {
        assert.equal(step.status, 'completed');
      }
    });

    it('stops on checkpoint failure', async () => {
      const ckpt = await engine.createCheckpoint({ data: 1 });
      const plan = engine.initiateMigration('pod_target', ckpt);
      // Tamper with checkpoint data to cause failure
      ckpt.data = { data: 'tampered' };
      const result = await engine.executePlan(plan);
      assert.equal(result.state, 'failed');
      assert.equal(result.steps[0].status, 'failed');
      assert.equal(result.steps[1].status, 'pending'); // never reached
    });
  });

  describe('getPlan()', () => {
    it('returns plan by id', async () => {
      const ckpt = await engine.createCheckpoint({});
      const plan = engine.initiateMigration('pod_x', ckpt);
      assert.equal(engine.getPlan(plan.migrationId), plan);
    });

    it('returns null for unknown id', () => {
      assert.equal(engine.getPlan('nonexistent'), null);
    });
  });

  describe('listPlans()', () => {
    it('returns all plans', async () => {
      const ckpt = await engine.createCheckpoint({});
      engine.initiateMigration('pod_a', ckpt);
      engine.initiateMigration('pod_b', ckpt);
      assert.equal(engine.listPlans().length, 2);
    });

    it('filters by state', async () => {
      const ckpt = await engine.createCheckpoint({});
      const p1 = engine.initiateMigration('pod_a', ckpt);
      engine.initiateMigration('pod_b', ckpt);
      await engine.executePlan(p1);
      assert.equal(engine.listPlans({ state: 'completed' }).length, 1);
      assert.equal(engine.listPlans({ state: 'idle' }).length, 1);
    });

    it('returns empty array when no plans exist', () => {
      assert.deepEqual(engine.listPlans(), []);
    });
  });

  describe('cancelPlan()', () => {
    it('cancels an idle plan', async () => {
      const ckpt = await engine.createCheckpoint({});
      const plan = engine.initiateMigration('pod_x', ckpt);
      assert.equal(engine.cancelPlan(plan.migrationId), true);
      assert.equal(plan.state, 'rolledBack');
    });

    it('cancels an in-progress plan', async () => {
      const ckpt = await engine.createCheckpoint({});
      const plan = engine.initiateMigration('pod_x', ckpt);
      await engine.stepCheckpoint(plan);
      assert.equal(engine.cancelPlan(plan.migrationId), true);
      assert.equal(plan.state, 'rolledBack');
    });

    it('returns false for completed plan', async () => {
      const ckpt = await engine.createCheckpoint({});
      const plan = engine.initiateMigration('pod_x', ckpt);
      await engine.executePlan(plan);
      assert.equal(engine.cancelPlan(plan.migrationId), false);
    });

    it('returns false for unknown id', () => {
      assert.equal(engine.cancelPlan('nonexistent'), false);
    });

    it('returns false for already failed plan', async () => {
      const ckpt = await engine.createCheckpoint({});
      const plan = engine.initiateMigration('pod_x', ckpt);
      plan.fail('forced');
      assert.equal(engine.cancelPlan(plan.migrationId), false);
    });
  });

  describe('activeMigrations', () => {
    it('counts non-terminal, non-idle migrations', async () => {
      assert.equal(engine.activeMigrations, 0);
      const ckpt = await engine.createCheckpoint({});
      const plan = engine.initiateMigration('pod_x', ckpt);
      assert.equal(engine.activeMigrations, 0); // idle doesn't count
      await engine.stepCheckpoint(plan);
      assert.equal(engine.activeMigrations, 1);
      await engine.stepTransfer(plan);
      assert.equal(engine.activeMigrations, 1);
      await engine.stepVerify(plan, ckpt.dataHash);
      assert.equal(engine.activeMigrations, 1);
      await engine.stepActivate(plan);
      assert.equal(engine.activeMigrations, 0); // completed
    });
  });
});

// ── DualActiveWindow ─────────────────────────────────────────────────────────

describe('DualActiveWindow', () => {
  it('constructor sets source/target pod IDs', () => {
    const w = new DualActiveWindow('src', 'tgt');
    assert.equal(w.sourcePodId, 'src');
    assert.equal(w.targetPodId, 'tgt');
    assert.equal(w.state, 'inactive');
  });

  it('constructor throws without required args', () => {
    assert.throws(() => new DualActiveWindow('', 'tgt'), /sourcePodId/);
    assert.throws(() => new DualActiveWindow('src', ''), /targetPodId/);
  });

  it('default windowMs is 30000', () => {
    const w = new DualActiveWindow('s', 't');
    assert.equal(w.windowMs, 30_000);
  });

  it('custom windowMs via options', () => {
    const w = new DualActiveWindow('s', 't', { windowMs: 5000 });
    assert.equal(w.windowMs, 5000);
  });

  it('start() transitions to active', () => {
    const w = new DualActiveWindow('s', 't');
    w.start();
    assert.equal(w.state, 'active');
    assert.equal(w.isActive(), true);
    assert.equal(typeof w.startedAt, 'number');
  });

  it('start() throws if already active', () => {
    const w = new DualActiveWindow('s', 't');
    w.start();
    assert.throws(() => w.start(), /Cannot start/);
  });

  it('start() throws if ended', () => {
    const w = new DualActiveWindow('s', 't');
    w.start();
    w.end();
    assert.throws(() => w.start(), /Cannot start/);
  });

  it('isActive() returns false when inactive', () => {
    const w = new DualActiveWindow('s', 't');
    assert.equal(w.isActive(), false);
  });

  it('isExpired() returns false when not active', () => {
    const w = new DualActiveWindow('s', 't', { windowMs: 1 });
    assert.equal(w.isExpired(), false);
  });

  it('isExpired() returns false within the window', () => {
    const w = new DualActiveWindow('s', 't', { windowMs: 60_000 });
    w.start();
    assert.equal(w.isExpired(), false);
  });

  it('isExpired() returns true after window elapses', () => {
    const w = new DualActiveWindow('s', 't', { windowMs: 100 });
    w.start();
    // Simulate time passing by using a future timestamp
    const future = Date.now() + 200;
    assert.equal(w.isExpired(future), true);
  });

  it('end() transitions to ended', () => {
    const w = new DualActiveWindow('s', 't');
    w.start();
    w.end();
    assert.equal(w.state, 'ended');
    assert.equal(w.isActive(), false);
  });

  it('end() throws if not active', () => {
    const w = new DualActiveWindow('s', 't');
    assert.throws(() => w.end(), /Cannot end/);
  });

  it('toJSON returns serializable object', () => {
    const w = new DualActiveWindow('src', 'tgt', { windowMs: 5000 });
    w.start();
    const json = w.toJSON();
    assert.doesNotThrow(() => JSON.stringify(json));
    assert.equal(json.sourcePodId, 'src');
    assert.equal(json.targetPodId, 'tgt');
    assert.equal(json.state, 'active');
    assert.equal(json.windowMs, 5000);
    assert.equal(typeof json.startedAt, 'number');
  });

  it('fromJSON restores inactive window', () => {
    const w = new DualActiveWindow('s', 't', { windowMs: 1234 });
    const restored = DualActiveWindow.fromJSON(w.toJSON());
    assert.equal(restored.sourcePodId, 's');
    assert.equal(restored.targetPodId, 't');
    assert.equal(restored.state, 'inactive');
    assert.equal(restored.windowMs, 1234);
  });

  it('fromJSON restores active window', () => {
    const w = new DualActiveWindow('s', 't');
    w.start();
    const json = w.toJSON();
    const restored = DualActiveWindow.fromJSON(json);
    assert.equal(restored.state, 'active');
    assert.equal(restored.startedAt, json.startedAt);
  });

  it('fromJSON restores ended window', () => {
    const w = new DualActiveWindow('s', 't');
    w.start();
    w.end();
    const json = w.toJSON();
    const restored = DualActiveWindow.fromJSON(json);
    assert.equal(restored.state, 'ended');
  });
});
