import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Kernel, KERNEL_CAP, requireCap,
  createPipe, createChannel,
  Clock, RNG,
} from '../src/index.mjs';

describe('Integration', () => {
  it('full tenant lifecycle', () => {
    const kernel = new Kernel({ clock: Clock.fixed(0, 0) });

    // Create tenant with limited caps
    const tenant = kernel.createTenant({
      capabilities: [KERNEL_CAP.CLOCK, KERNEL_CAP.IPC, KERNEL_CAP.STDIO],
      env: { USER: 'alice', HOME: '/home/alice' },
    });

    // Verify caps
    requireCap(tenant.caps, KERNEL_CAP.CLOCK);
    requireCap(tenant.caps, KERNEL_CAP.IPC);
    assert.throws(() => requireCap(tenant.caps, KERNEL_CAP.NET), { name: 'CapabilityDeniedError' });

    // Allocate resources owned by tenant
    const h1 = kernel.resources.allocate('stream', 'myStream', tenant.id);
    const h2 = kernel.resources.allocate('port', 'myPort', tenant.id);
    assert.equal(kernel.resources.listByOwner(tenant.id).length, 2);

    // Destroy tenant — resources cleaned up
    kernel.destroyTenant(tenant.id);
    assert.equal(kernel.resources.listByOwner(tenant.id).length, 0);
    assert.equal(kernel.resources.size, 0);

    kernel.close();
  });

  it('IPC between tenants via MessagePort', async () => {
    const kernel = new Kernel();

    const t1 = kernel.createTenant({ capabilities: [KERNEL_CAP.IPC] });
    const t2 = kernel.createTenant({ capabilities: [KERNEL_CAP.IPC] });

    const [portA, portB] = createChannel();
    const received = [];
    portB.onMessage(msg => received.push(msg));
    portA.post({ from: t1.id, data: 'hello' });

    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(received.length, 1);
    assert.equal(received[0].from, t1.id);

    portA.close();
    portB.close();
    kernel.close();
  });

  it('service registry with kernel services', async () => {
    const kernel = new Kernel();

    // Register a service
    const handler = { handle(req) { return `echo: ${req}`; } };
    kernel.services.register('echo', handler, { metadata: { version: '1.0' } });

    // Lookup
    const entry = await kernel.services.lookup('echo');
    assert.equal(entry.name, 'echo');
    assert.equal(entry.listener.handle('test'), 'echo: test');

    // Unregister
    kernel.services.unregister('echo');
    await assert.rejects(() => kernel.services.lookup('echo'), { name: 'NotFoundError' });

    kernel.close();
  });

  it('ByteStream pipe through tenant stdio', async () => {
    const kernel = new Kernel();
    const [outReader, outWriter] = createPipe();

    const tenant = kernel.createTenant({
      capabilities: [KERNEL_CAP.STDIO],
      stdio: { stdout: outWriter },
    });

    await tenant.stdio.println('hello from tenant');
    const chunk = await outReader.read();
    assert.equal(new TextDecoder().decode(chunk), 'hello from tenant\n');

    await outReader.close();
    await outWriter.close();
    kernel.close();
  });

  it('chaos + tracer pipeline', async () => {
    const rng = RNG.seeded(42);
    const clock = Clock.fixed(0, 0);
    const kernel = new Kernel({ rng, clock });

    // Create a tenant to generate log events
    kernel.createTenant({ capabilities: [KERNEL_CAP.CHAOS] });

    kernel.chaos.enable();
    kernel.chaos.configure({ latencyMs: 50 });

    const before = clock.nowMonotonic();
    await kernel.chaos.maybeDelay();
    const after = clock.nowMonotonic();
    assert.equal(after - before, 50);

    // Tracer should have kernel log events (tenant creation logs)
    const events = kernel.tracer.snapshot();
    assert.ok(events.length > 0);
    assert.ok(events.some(e => e.type === 'log'));

    kernel.close();
  });

  it('signal controller for tenant shutdown', () => {
    const kernel = new Kernel();
    const tenant = kernel.createTenant({ capabilities: [KERNEL_CAP.SIGNAL] });

    const shutdownLog = [];
    tenant.signals.onSignal('TERM', () => shutdownLog.push('cleanup'));
    tenant.signals.signal('TERM');
    assert.deepEqual(shutdownLog, ['cleanup']);
    assert.equal(tenant.signals.hasFired('TERM'), true);

    // Abort signal integration
    const sig = tenant.signals.abortSignal('TERM');
    assert.equal(sig.aborted, true);

    kernel.close();
  });

  it('resource table with typed access', () => {
    const kernel = new Kernel();
    const t = kernel.createTenant({ capabilities: [] });

    const h = kernel.resources.allocate('socket', { fd: 5 }, t.id);
    const val = kernel.resources.getTyped(h, 'socket');
    assert.deepEqual(val, { fd: 5 });

    assert.throws(() => kernel.resources.getTyped(h, 'stream'), { name: 'HandleTypeMismatchError' });

    // Transfer
    const t2 = kernel.createTenant({ capabilities: [] });
    kernel.resources.transfer(h, t2.id);
    assert.equal(kernel.resources.get(h).owner, t2.id);

    kernel.close();
  });

  it('multiple tenants with isolated environments', () => {
    const kernel = new Kernel();

    const t1 = kernel.createTenant({
      capabilities: [KERNEL_CAP.ENV],
      env: { DB: 'postgres', MODE: 'prod' },
    });
    const t2 = kernel.createTenant({
      capabilities: [KERNEL_CAP.ENV],
      env: { DB: 'sqlite', MODE: 'dev' },
    });

    assert.equal(t1.env.get('DB'), 'postgres');
    assert.equal(t2.env.get('DB'), 'sqlite');
    assert.notEqual(t1.env, t2.env);

    kernel.close();
  });

  it('deterministic replay with seeded rng + fixed clock', async () => {
    // First run
    const rng1 = RNG.seeded(999);
    const clock1 = Clock.fixed(0, 0);
    const kernel1 = new Kernel({ rng: rng1, clock: clock1 });
    kernel1.chaos.enable();
    kernel1.chaos.configure({ dropRate: 0.5 });
    const drops1 = [];
    for (let i = 0; i < 10; i++) drops1.push(kernel1.chaos.shouldDrop());
    kernel1.close();

    // Replay with same seed
    const rng2 = RNG.seeded(999);
    const clock2 = Clock.fixed(0, 0);
    const kernel2 = new Kernel({ rng: rng2, clock: clock2 });
    kernel2.chaos.enable();
    kernel2.chaos.configure({ dropRate: 0.5 });
    const drops2 = [];
    for (let i = 0; i < 10; i++) drops2.push(kernel2.chaos.shouldDrop());
    kernel2.close();

    assert.deepEqual(drops1, drops2);
  });
});
