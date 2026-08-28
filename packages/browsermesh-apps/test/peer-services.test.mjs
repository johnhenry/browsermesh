// Run with: node --import ./test/_setup-globals.mjs --test test/peer-services.test.mjs
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  SERVICE_TYPES,
  SERVICE_TTL_DEFAULT,
  ServiceAdvertiser,
  ServiceBrowser,
} from '../src/peer-services.mjs';

// ── SERVICE_TYPES ──────────────────────────────────────────────────

describe('SERVICE_TYPES', () => {
  it('contains all expected types', () => {
    assert.equal(SERVICE_TYPES.AGENT, 'agent');
    assert.equal(SERVICE_TYPES.TERMINAL, 'terminal');
    assert.equal(SERVICE_TYPES.FILES, 'files');
    assert.equal(SERVICE_TYPES.COMPUTE, 'compute');
    assert.equal(SERVICE_TYPES.MODEL, 'model');
    assert.equal(SERVICE_TYPES.HTTP_PROXY, 'http-proxy');
  });

  it('is frozen', () => {
    assert.ok(Object.isFrozen(SERVICE_TYPES));
  });

  it('has exactly 6 entries', () => {
    assert.equal(Object.keys(SERVICE_TYPES).length, 6);
  });
});

// ── SERVICE_TTL_DEFAULT ────────────────────────────────────────────

describe('SERVICE_TTL_DEFAULT', () => {
  it('is 5 minutes in milliseconds', () => {
    assert.equal(SERVICE_TTL_DEFAULT, 300_000);
  });
});

// ── ServiceAdvertiser ──────────────────────────────────────────────

describe('ServiceAdvertiser', () => {
  /** @type {ServiceAdvertiser} */
  let adv;
  /** @type {object[]} */
  let broadcasts;

  beforeEach(() => {
    broadcasts = [];
    adv = new ServiceAdvertiser({
      localPodId: 'pod-local',
      broadcastFn: (msg) => broadcasts.push(msg),
    });
  });

  it('constructor throws without localPodId', () => {
    assert.throws(
      () => new ServiceAdvertiser({ localPodId: '' }),
      /localPodId is required/,
    );
  });

  it('starts with no services', () => {
    assert.deepEqual(adv.listServices(), []);
  });

  // -- advertise --

  it('advertise creates a descriptor with correct fields', () => {
    const desc = adv.advertise({ name: 'my-agent', type: 'agent' });
    assert.equal(desc.name, 'my-agent');
    assert.equal(desc.type, 'agent');
    assert.equal(desc.podId, 'pod-local');
    assert.equal(desc.address, 'mesh://pod-local/my-agent');
    assert.equal(desc.version, '1.0.0');
    assert.deepEqual(desc.capabilities, []);
    assert.equal(desc.pricing, null);
    assert.equal(desc.metadata, null);
    assert.equal(typeof desc.registeredAt, 'number');
    assert.equal(desc.ttl, SERVICE_TTL_DEFAULT);
  });

  it('advertise accepts optional fields', () => {
    const desc = adv.advertise({
      name: 'compute-1',
      type: 'compute',
      version: '2.0.0',
      capabilities: ['gpu', 'wasm'],
      pricing: { cost: 0.01 },
      metadata: { region: 'us-east' },
    });
    assert.equal(desc.version, '2.0.0');
    assert.deepEqual(desc.capabilities, ['gpu', 'wasm']);
    assert.deepEqual(desc.pricing, { cost: 0.01 });
    assert.deepEqual(desc.metadata, { region: 'us-east' });
  });

  it('advertise throws without name', () => {
    assert.throws(
      () => adv.advertise({ type: 'agent' }),
      /service\.name is required/,
    );
  });

  it('advertise throws without type', () => {
    assert.throws(
      () => adv.advertise({ name: 'foo' }),
      /service\.type is required/,
    );
  });

  it('advertise broadcasts to peers', () => {
    adv.advertise({ name: 'svc-1', type: 'terminal' });
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].type, 'service:advertise');
    assert.equal(broadcasts[0].service.name, 'svc-1');
  });

  it('advertise emits advertise event', () => {
    const events = [];
    adv.on('advertise', (desc) => events.push(desc));
    adv.advertise({ name: 'svc-1', type: 'agent' });
    assert.equal(events.length, 1);
    assert.equal(events[0].name, 'svc-1');
  });

  it('advertise overwrites existing service with same name', () => {
    adv.advertise({ name: 'svc-1', type: 'agent', version: '1.0.0' });
    adv.advertise({ name: 'svc-1', type: 'agent', version: '2.0.0' });
    assert.equal(adv.listServices().length, 1);
    assert.equal(adv.getService('svc-1').version, '2.0.0');
  });

  // -- withdraw --

  it('withdraw removes an advertised service', () => {
    adv.advertise({ name: 'svc-1', type: 'agent' });
    const result = adv.withdraw('svc-1');
    assert.equal(result, true);
    assert.deepEqual(adv.listServices(), []);
  });

  it('withdraw returns false for unknown service', () => {
    assert.equal(adv.withdraw('nonexistent'), false);
  });

  it('withdraw broadcasts to peers', () => {
    adv.advertise({ name: 'svc-1', type: 'terminal' });
    broadcasts.length = 0;
    adv.withdraw('svc-1');
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].type, 'service:withdraw');
    assert.equal(broadcasts[0].name, 'svc-1');
    assert.equal(broadcasts[0].address, 'mesh://pod-local/svc-1');
  });

  it('withdraw emits withdraw event', () => {
    const events = [];
    adv.on('withdraw', (desc) => events.push(desc));
    adv.advertise({ name: 'svc-1', type: 'agent' });
    adv.withdraw('svc-1');
    assert.equal(events.length, 1);
    assert.equal(events[0].name, 'svc-1');
  });

  // -- listServices / getService --

  it('listServices returns all advertised services', () => {
    adv.advertise({ name: 'svc-1', type: 'agent' });
    adv.advertise({ name: 'svc-2', type: 'terminal' });
    const list = adv.listServices();
    assert.equal(list.length, 2);
  });

  it('getService returns descriptor for known service', () => {
    adv.advertise({ name: 'svc-1', type: 'files' });
    const desc = adv.getService('svc-1');
    assert.equal(desc.name, 'svc-1');
    assert.equal(desc.type, 'files');
  });

  it('getService returns null for unknown service', () => {
    assert.equal(adv.getService('nope'), null);
  });

  // -- announceToNewPeer --

  it('announceToNewPeer sends all services to a peer', () => {
    adv.advertise({ name: 'svc-1', type: 'agent' });
    adv.advertise({ name: 'svc-2', type: 'compute' });

    const sent = [];
    adv.announceToNewPeer((msg) => sent.push(msg));

    assert.equal(sent.length, 2);
    assert.equal(sent[0].type, 'service:advertise');
    assert.equal(sent[1].type, 'service:advertise');
    const names = sent.map(m => m.service.name).sort();
    assert.deepEqual(names, ['svc-1', 'svc-2']);
  });

  it('announceToNewPeer throws if sendFn is not a function', () => {
    assert.throws(
      () => adv.announceToNewPeer('not-a-function'),
      /sendFn must be a function/,
    );
  });

  // -- event off --

  it('off removes a listener', () => {
    const events = [];
    const handler = (desc) => events.push(desc);
    adv.on('advertise', handler);
    adv.advertise({ name: 'svc-1', type: 'agent' });
    assert.equal(events.length, 1);

    adv.off('advertise', handler);
    adv.advertise({ name: 'svc-2', type: 'agent' });
    assert.equal(events.length, 1); // no new event
  });

  // -- toJSON --

  it('toJSON returns serializable snapshot', () => {
    adv.advertise({ name: 'svc-1', type: 'agent' });
    const json = adv.toJSON();
    assert.equal(json.localPodId, 'pod-local');
    assert.equal(json.services.length, 1);
    assert.equal(json.services[0].name, 'svc-1');
  });

  // -- no broadcastFn --

  it('works without broadcastFn (no throws)', () => {
    const plain = new ServiceAdvertiser({ localPodId: 'pod-x' });
    const desc = plain.advertise({ name: 's', type: 'agent' });
    assert.equal(desc.name, 's');
    assert.equal(plain.withdraw('s'), true);
  });
});

// ── ServiceBrowser ─────────────────────────────────────────────────

describe('ServiceBrowser', () => {
  /** @type {ServiceBrowser} */
  let browser;

  /** Helper to make a service descriptor */
  function mkService(name, type, podId, opts = {}) {
    return {
      name,
      type,
      podId,
      version: opts.version ?? '1.0.0',
      capabilities: opts.capabilities ?? [],
      pricing: null,
      metadata: null,
      address: `mesh://${podId}/${name}`,
      registeredAt: opts.registeredAt ?? Date.now(),
      ttl: opts.ttl ?? SERVICE_TTL_DEFAULT,
    };
  }

  beforeEach(() => {
    browser = new ServiceBrowser();
  });

  it('starts empty', () => {
    assert.equal(browser.size, 0);
    assert.deepEqual(browser.discover(), []);
  });

  // -- handleAdvertisement --

  it('handleAdvertisement adds a service', () => {
    const svc = mkService('svc-1', 'agent', 'pod-a');
    browser.handleAdvertisement(svc);
    assert.equal(browser.size, 1);
  });

  it('handleAdvertisement emits discovered event', () => {
    const events = [];
    browser.on('discovered', (s) => events.push(s));
    const svc = mkService('svc-1', 'agent', 'pod-a');
    browser.handleAdvertisement(svc);
    assert.equal(events.length, 1);
    assert.equal(events[0].name, 'svc-1');
  });

  it('handleAdvertisement updates existing service', () => {
    const svc1 = mkService('svc-1', 'agent', 'pod-a', { version: '1.0.0' });
    const svc2 = mkService('svc-1', 'agent', 'pod-a', { version: '2.0.0' });
    browser.handleAdvertisement(svc1);
    browser.handleAdvertisement(svc2);
    assert.equal(browser.size, 1);
    assert.equal(browser.getService('mesh://pod-a/svc-1').version, '2.0.0');
  });

  it('handleAdvertisement ignores null or missing address', () => {
    browser.handleAdvertisement(null);
    browser.handleAdvertisement({});
    browser.handleAdvertisement({ name: 'x' });
    assert.equal(browser.size, 0);
  });

  // -- handleWithdrawal --

  it('handleWithdrawal removes a service', () => {
    const svc = mkService('svc-1', 'agent', 'pod-a');
    browser.handleAdvertisement(svc);
    browser.handleWithdrawal('mesh://pod-a/svc-1');
    assert.equal(browser.size, 0);
  });

  it('handleWithdrawal emits lost event', () => {
    const events = [];
    browser.on('lost', (s) => events.push(s));
    const svc = mkService('svc-1', 'agent', 'pod-a');
    browser.handleAdvertisement(svc);
    browser.handleWithdrawal('mesh://pod-a/svc-1');
    assert.equal(events.length, 1);
    assert.equal(events[0].name, 'svc-1');
  });

  it('handleWithdrawal is no-op for unknown address', () => {
    browser.handleWithdrawal('mesh://pod-x/unknown');
    assert.equal(browser.size, 0);
  });

  // -- discover --

  it('discover returns all services when no filter', () => {
    browser.handleAdvertisement(mkService('svc-1', 'agent', 'pod-a'));
    browser.handleAdvertisement(mkService('svc-2', 'terminal', 'pod-b'));
    assert.equal(browser.discover().length, 2);
  });

  it('discover filters by type', () => {
    browser.handleAdvertisement(mkService('svc-1', 'agent', 'pod-a'));
    browser.handleAdvertisement(mkService('svc-2', 'terminal', 'pod-b'));
    const result = browser.discover({ type: 'agent' });
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'svc-1');
  });

  it('discover filters by capability', () => {
    browser.handleAdvertisement(mkService('svc-1', 'compute', 'pod-a', { capabilities: ['gpu', 'wasm'] }));
    browser.handleAdvertisement(mkService('svc-2', 'compute', 'pod-b', { capabilities: ['cpu'] }));
    const result = browser.discover({ capability: 'gpu' });
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'svc-1');
  });

  it('discover filters by podId', () => {
    browser.handleAdvertisement(mkService('svc-1', 'agent', 'pod-a'));
    browser.handleAdvertisement(mkService('svc-2', 'agent', 'pod-b'));
    const result = browser.discover({ podId: 'pod-b' });
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'svc-2');
  });

  it('discover with combined filters', () => {
    browser.handleAdvertisement(mkService('svc-1', 'agent', 'pod-a'));
    browser.handleAdvertisement(mkService('svc-2', 'terminal', 'pod-a'));
    browser.handleAdvertisement(mkService('svc-3', 'agent', 'pod-b'));
    const result = browser.discover({ type: 'agent', podId: 'pod-a' });
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'svc-1');
  });

  // -- getService --

  it('getService returns service by address', () => {
    browser.handleAdvertisement(mkService('svc-1', 'agent', 'pod-a'));
    const svc = browser.getService('mesh://pod-a/svc-1');
    assert.equal(svc.name, 'svc-1');
  });

  it('getService returns null for unknown address', () => {
    assert.equal(browser.getService('mesh://pod-z/nope'), null);
  });

  // -- getServicesByPod --

  it('getServicesByPod returns services from a specific pod', () => {
    browser.handleAdvertisement(mkService('svc-1', 'agent', 'pod-a'));
    browser.handleAdvertisement(mkService('svc-2', 'terminal', 'pod-a'));
    browser.handleAdvertisement(mkService('svc-3', 'agent', 'pod-b'));
    const result = browser.getServicesByPod('pod-a');
    assert.equal(result.length, 2);
    assert.ok(result.every(s => s.podId === 'pod-a'));
  });

  it('getServicesByPod returns empty for unknown pod', () => {
    assert.deepEqual(browser.getServicesByPod('pod-z'), []);
  });

  // -- getServicesByType --

  it('getServicesByType returns services of a given type', () => {
    browser.handleAdvertisement(mkService('svc-1', 'agent', 'pod-a'));
    browser.handleAdvertisement(mkService('svc-2', 'terminal', 'pod-a'));
    browser.handleAdvertisement(mkService('svc-3', 'agent', 'pod-b'));
    const result = browser.getServicesByType('agent');
    assert.equal(result.length, 2);
    assert.ok(result.every(s => s.type === 'agent'));
  });

  it('getServicesByType returns empty for unknown type', () => {
    assert.deepEqual(browser.getServicesByType('nonexistent'), []);
  });

  // -- pruneExpired --

  it('pruneExpired removes expired services', () => {
    browser.handleAdvertisement(mkService('svc-old', 'agent', 'pod-a', {
      registeredAt: 1000,
      ttl: 100,
    }));
    browser.handleAdvertisement(mkService('svc-new', 'agent', 'pod-b'));
    const pruned = browser.pruneExpired();
    assert.equal(pruned, 1);
    assert.equal(browser.size, 1);
    assert.equal(browser.getService('mesh://pod-a/svc-old'), null);
    assert.notEqual(browser.getService('mesh://pod-b/svc-new'), null);
  });

  it('pruneExpired returns 0 when nothing expired', () => {
    browser.handleAdvertisement(mkService('svc-1', 'agent', 'pod-a'));
    assert.equal(browser.pruneExpired(), 0);
  });

  it('pruneExpired emits lost event for each pruned service', () => {
    const events = [];
    browser.on('lost', (s) => events.push(s));
    browser.handleAdvertisement(mkService('svc-old', 'agent', 'pod-a', {
      registeredAt: 1000,
      ttl: 100,
    }));
    browser.pruneExpired();
    assert.equal(events.length, 1);
    assert.equal(events[0].name, 'svc-old');
  });

  it('pruneExpired respects custom now parameter', () => {
    const svc = mkService('svc-1', 'agent', 'pod-a', {
      registeredAt: 5000,
      ttl: 1000,
    });
    browser.handleAdvertisement(svc);
    assert.equal(browser.pruneExpired(5500), 0);  // not yet
    assert.equal(browser.pruneExpired(6000), 1);  // exactly at expiry
  });

  // -- off --

  it('off removes a listener', () => {
    const events = [];
    const handler = (s) => events.push(s);
    browser.on('discovered', handler);
    browser.handleAdvertisement(mkService('svc-1', 'agent', 'pod-a'));
    assert.equal(events.length, 1);

    browser.off('discovered', handler);
    browser.handleAdvertisement(mkService('svc-2', 'agent', 'pod-b'));
    assert.equal(events.length, 1); // no new event
  });

  // -- toJSON --

  it('toJSON returns serializable snapshot', () => {
    browser.handleAdvertisement(mkService('svc-1', 'agent', 'pod-a'));
    browser.handleAdvertisement(mkService('svc-2', 'terminal', 'pod-b'));
    const json = browser.toJSON();
    assert.equal(json.services.length, 2);
  });
});
