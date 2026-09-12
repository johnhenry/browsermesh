import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Kernel } from '../src/kernel.mjs';
import { KERNEL_CAP } from '../src/constants.mjs';
import { Clock } from '../src/clock.mjs';

describe('Kernel', () => {
  it('creates with default subsystems', () => {
    const kernel = new Kernel();
    assert.ok(kernel.clock);
    assert.ok(kernel.rng);
    assert.ok(kernel.resources);
    assert.ok(kernel.tracer);
    assert.ok(kernel.log);
    assert.ok(kernel.chaos);
    assert.ok(kernel.services);
    assert.ok(kernel.signals);
    kernel.close();
  });

  it('accepts custom clock', () => {
    const clock = Clock.fixed(100, 200);
    const kernel = new Kernel({ clock });
    assert.equal(kernel.clock.nowMonotonic(), 100);
    kernel.close();
  });

  it('createTenant returns tenant with id and caps', () => {
    const kernel = new Kernel();
    const tenant = kernel.createTenant({
      capabilities: [KERNEL_CAP.CLOCK, KERNEL_CAP.RNG],
      env: { MODE: 'test' },
    });
    assert.match(tenant.id, /^tenant_\d+$/);
    assert.ok(tenant.caps.clock);
    assert.ok(tenant.caps.rng);
    assert.equal(tenant.env.get('MODE'), 'test');
    assert.ok(tenant.stdio);
    assert.ok(tenant.signals);
    kernel.close();
  });

  it('destroyTenant drops owned resources', () => {
    const kernel = new Kernel();
    const tenant = kernel.createTenant({ capabilities: [KERNEL_CAP.ALL] });
    kernel.resources.allocate('stream', 'a', tenant.id);
    kernel.resources.allocate('stream', 'b', tenant.id);
    assert.equal(kernel.resources.listByOwner(tenant.id).length, 2);
    kernel.destroyTenant(tenant.id);
    assert.equal(kernel.resources.listByOwner(tenant.id).length, 0);
    kernel.close();
  });

  it('destroyTenant for non-existent id is no-op', () => {
    const kernel = new Kernel();
    kernel.destroyTenant('tenant_999'); // no throw
    kernel.close();
  });

  it('getTenant returns tenant or undefined', () => {
    const kernel = new Kernel();
    const tenant = kernel.createTenant({ capabilities: [] });
    assert.equal(kernel.getTenant(tenant.id), tenant);
    assert.equal(kernel.getTenant('tenant_999'), undefined);
    kernel.close();
  });

  it('listTenants', () => {
    const kernel = new Kernel();
    kernel.createTenant({ capabilities: [] });
    kernel.createTenant({ capabilities: [] });
    assert.equal(kernel.listTenants().length, 2);
    kernel.close();
  });

  it('close destroys all tenants', () => {
    const kernel = new Kernel();
    const t1 = kernel.createTenant({ capabilities: [] });
    const t2 = kernel.createTenant({ capabilities: [] });
    kernel.resources.allocate('stream', 'x', t1.id);
    kernel.close();
    assert.equal(kernel.listTenants().length, 0);
    assert.equal(kernel.resources.size, 0);
  });

  it('tracer captures tenant creation events', () => {
    const kernel = new Kernel();
    kernel.createTenant({ capabilities: [KERNEL_CAP.CLOCK] });
    const events = kernel.tracer.snapshot();
    assert.ok(events.some(e => e.type === 'log' && e.message.includes('Tenant created')));
    kernel.close();
  });

  it('tenantCount tracks active tenants across create/destroy', () => {
    const kernel = new Kernel();
    assert.equal(kernel.tenantCount, 0);
    const t1 = kernel.createTenant({ capabilities: [] });
    kernel.createTenant({ capabilities: [] });
    assert.equal(kernel.tenantCount, 2);
    kernel.destroyTenant(t1.id);
    assert.equal(kernel.tenantCount, 1);
    kernel.close();
    assert.equal(kernel.tenantCount, 0);
  });

  it('startTime is captured at construction and uptime tracks elapsed wall time', () => {
    let wall = 1000;
    const clock = new Clock({ wallFn: () => wall });
    const kernel = new Kernel({ clock });
    assert.equal(kernel.startTime, 1000);
    assert.equal(kernel.uptime, 0);
    wall = 1500;
    assert.equal(kernel.uptime, 500);
  });

  describe('resourcesFor (tenant-scoped resource access)', () => {
    it('lets a tenant get/drop its own resource', () => {
      const kernel = new Kernel();
      const tenant = kernel.createTenant({ capabilities: [] });
      const handle = kernel.resources.allocate('stream', 'mine', tenant.id);

      const mine = kernel.resourcesFor(tenant.id);
      assert.deepEqual(mine.get(handle), { type: 'stream', value: 'mine', owner: tenant.id });
      assert.equal(mine.getTyped(handle, 'stream'), 'mine');
      assert.equal(mine.drop(handle), 'mine');
      assert.equal(kernel.resources.has(handle), false);

      kernel.close();
    });

    it('throws ResourceOwnershipError, not undefined/success, when tenant view is used with wrong owner', () => {
      const kernel = new Kernel();
      const tenantA = kernel.createTenant({ capabilities: [] });
      const tenantB = kernel.createTenant({ capabilities: [] });
      const handle = kernel.resources.allocate('stream', 'a-data', tenantA.id);

      const asB = kernel.resourcesFor(tenantB.id);
      assert.throws(() => asB.get(handle), { name: 'ResourceOwnershipError' });
      assert.throws(() => asB.getTyped(handle, 'stream'), { name: 'ResourceOwnershipError' });
      assert.throws(() => asB.drop(handle), { name: 'ResourceOwnershipError' });

      // Resource must still exist and be untouched — drop() must not have succeeded.
      assert.equal(kernel.resources.has(handle), true);
      assert.equal(kernel.resources.get(handle).value, 'a-data');

      kernel.close();
    });

    it('end-to-end: tenant-scoped view cannot reach another tenant resource by guessing the handle', () => {
      const kernel = new Kernel();
      const tenantA = kernel.createTenant({ capabilities: [] });
      const tenantB = kernel.createTenant({ capabilities: [] });

      // tenant A allocates a resource via the ambient table (as kernel-internal code would
      // on tenant A's behalf).
      const secretHandle = kernel.resources.allocate('socket', { secret: 42 }, tenantA.id);

      // tenant B only ever touches resources through its own tenant-scoped view.
      const asTenantB = kernel.resourcesFor(tenantB.id);

      // Guessing/holding the handle string alone is not enough — ownership is enforced.
      assert.throws(() => asTenantB.get(secretHandle), { name: 'ResourceOwnershipError' });
      assert.throws(() => asTenantB.drop(secretHandle), { name: 'ResourceOwnershipError' });

      // tenant A's own scoped view still works fine.
      const asTenantA = kernel.resourcesFor(tenantA.id);
      assert.deepEqual(asTenantA.get(secretHandle).value, { secret: 42 });

      kernel.close();
    });
  });

  describe('meshFor (tenant-scoped mesh capability)', () => {
    // Duck-typed stand-in for a real `PeerNode` + `PeerRegistry` pair (see
    // browsermesh-apps/src/peer-node.mjs, peer-registry.mjs). The kernel package has
    // zero dependency on browsermesh-apps, so its own tests exercise the interface
    // contract with a minimal mock rather than a real PeerNode — the real-peer proof
    // lives in browsermesh-apps/test/real-peer/kernel-mesh.test.mjs.
    function createMockMeshProvider() {
      const dataListeners = new Set();
      const sent = [];
      const grants = new Map(); // peerId -> Set<'mesh:send'|'mesh:receive'>
      return {
        sent,
        grant(peerId, scopes) { grants.set(peerId, new Set(scopes)); },
        sendTo(peerId, data) { sent.push({ peerId, data }); return Promise.resolve(); },
        onIncomingData(cb) {
          dataListeners.add(cb);
          return () => dataListeners.delete(cb);
        },
        deliver(peerId, data, meta = { sessionId: 's1', transport: 'webrtc' }) {
          for (const cb of [...dataListeners]) cb(peerId, data, meta);
        },
        registry: {
          checkAccess(peerId, resource, action) {
            const scopes = grants.get(peerId);
            const allowed = !!scopes && scopes.has(`${resource}:${action}`);
            return allowed ? { allowed: true } : { allowed: false, reason: 'scope_denied' };
          },
        },
      };
    }

    it('returns null when no mesh provider was injected into the kernel', () => {
      const kernel = new Kernel();
      const tenant = kernel.createTenant({ capabilities: [] });
      assert.equal(kernel.meshFor(tenant.id), null);
      kernel.close();
    });

    it('kernel.mesh (ambient) exposes the raw injected provider', () => {
      const mesh = createMockMeshProvider();
      const kernel = new Kernel({ mesh });
      assert.equal(kernel.mesh, mesh);
      kernel.close();
    });

    it('send() calls provider.sendTo() when registry.checkAccess() allows it', async () => {
      const mesh = createMockMeshProvider();
      mesh.grant('peer-a', ['mesh:send']);
      const kernel = new Kernel({ mesh });
      const tenant = kernel.createTenant({ capabilities: [] });

      const view = kernel.meshFor(tenant.id);
      await view.send('peer-a', { hello: 'world' });
      assert.deepEqual(mesh.sent, [{ peerId: 'peer-a', data: { hello: 'world' } }]);

      kernel.close();
    });

    it('send() throws MeshAccessDeniedError, and never calls provider.sendTo(), when registry.checkAccess() denies it', async () => {
      const mesh = createMockMeshProvider(); // 'peer-b' was never granted anything
      const kernel = new Kernel({ mesh });
      const tenant = kernel.createTenant({ capabilities: [] });

      const view = kernel.meshFor(tenant.id);
      await assert.rejects(() => view.send('peer-b', 'data'), { name: 'MeshAccessDeniedError' });
      assert.deepEqual(mesh.sent, [], 'sendTo must not have been called');

      kernel.close();
    });

    it('onReceive() only delivers data from peers registry.checkAccess() allows for the receive action', () => {
      const mesh = createMockMeshProvider();
      mesh.grant('peer-a', ['mesh:receive']);
      const kernel = new Kernel({ mesh });
      const tenant = kernel.createTenant({ capabilities: [] });

      const view = kernel.meshFor(tenant.id);
      const received = [];
      view.onReceive((peerId, data) => received.push({ peerId, data }));

      mesh.deliver('peer-a', 'allowed'); // granted
      mesh.deliver('peer-b', 'denied'); // never granted

      assert.deepEqual(received, [{ peerId: 'peer-a', data: 'allowed' }]);

      kernel.close();
    });

    it('mesh view exposes only send/onReceive, not the full underlying provider API', () => {
      const mesh = createMockMeshProvider();
      const kernel = new Kernel({ mesh });
      const tenant = kernel.createTenant({ capabilities: [] });

      const view = kernel.meshFor(tenant.id);
      assert.deepEqual(Object.keys(view).sort(), ['onReceive', 'send']);
      assert.equal(view.registry, undefined);
      assert.equal(view.deliver, undefined);
      assert.ok(Object.isFrozen(view));

      kernel.close();
    });
  });
});
