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
});
