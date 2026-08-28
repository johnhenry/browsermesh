// Run with: node --import ./test/_setup-globals.mjs --test test/hardening.test.mjs
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  RetryWithBackoff,
  CIRCUIT_STATES,
  TransportHealthCheck,
  TRANSPORT_HEALTH_STATUSES,
  ConnectionPool,
  TransportMetrics,
  MetricsRegistry,
  TransportFailover,
} from '../src/hardening.mjs';

// Sibling package, not yet published — MockMeshTransport/MeshTransportNegotiator
// live in browsermesh-transport (verified byte-identical to the live
// web/clawser-mesh-transport.js this was ported from). Once both packages
// are published, switch this to a real "browsermesh-transport" dependency.
import {
  MockMeshTransport,
  MeshTransportNegotiator,
} from '../../browsermesh-transport/src/transport.mjs';

// ── Helpers ─────────────────────────────────────────────────────────

const noopSleep = () => Promise.resolve();

const makeConnectedMock = async (type = 'wsh-ws') => {
  const t = new MockMeshTransport(type);
  await t.connect('test://ep');
  return t;
};

// ══════════════════════════════════════════════════════════════════════
// 1. RetryWithBackoff
// ══════════════════════════════════════════════════════════════════════

describe('CIRCUIT_STATES', () => {
  it('is frozen with three states', () => {
    assert.ok(Object.isFrozen(CIRCUIT_STATES));
    assert.deepEqual(CIRCUIT_STATES, ['closed', 'open', 'half-open']);
  });
});

describe('RetryWithBackoff', () => {
  /** @type {RetryWithBackoff} */
  let retry;

  beforeEach(() => {
    retry = new RetryWithBackoff({
      maxRetries: 3,
      baseDelayMs: 100,
      sleepFn: noopSleep,
    });
  });

  it('succeeds on first attempt', async () => {
    const result = await retry.execute(async () => 42);
    assert.equal(result, 42);
    assert.equal(retry.circuitState, 'closed');
    assert.equal(retry.failureCount, 0);
    assert.equal(retry.successCount, 1);
  });

  it('retries on failure and succeeds', async () => {
    let attempts = 0;
    const result = await retry.execute(async () => {
      attempts++;
      if (attempts < 3) throw new Error('fail');
      return 'ok';
    });
    assert.equal(result, 'ok');
    assert.equal(attempts, 3);
    assert.equal(retry.failureCount, 0);
  });

  it('opens circuit after maxRetries consecutive failures', async () => {
    await assert.rejects(
      () => retry.execute(async () => { throw new Error('always fail'); }),
      /Circuit breaker opened after 3 failures/,
    );
    assert.equal(retry.circuitState, 'open');
    assert.equal(retry.failureCount, 3);
  });

  it('rejects immediately when circuit is open', async () => {
    // Open the circuit
    await assert.rejects(
      () => retry.execute(async () => { throw new Error('fail'); }),
    );
    assert.equal(retry.circuitState, 'open');

    // Subsequent call should reject immediately
    await assert.rejects(
      () => retry.execute(async () => 'should not run'),
      /Circuit breaker is open/,
    );
  });

  it('transitions to half-open after resetTimeout', async () => {
    let now = 1000;
    const r = new RetryWithBackoff({
      maxRetries: 2,
      resetTimeoutMs: 500,
      sleepFn: noopSleep,
      nowFn: () => now,
    });

    // Open the circuit
    await assert.rejects(
      () => r.execute(async () => { throw new Error('fail'); }),
    );
    assert.equal(r.circuitState, 'open');

    // Advance time past reset timeout
    now = 2000;

    // Should allow one attempt (half-open)
    const result = await r.execute(async () => 'recovered');
    assert.equal(result, 'recovered');
    assert.equal(r.circuitState, 'closed');
  });

  it('half-open goes back to open on failure', async () => {
    let now = 1000;
    const r = new RetryWithBackoff({
      maxRetries: 2,
      resetTimeoutMs: 500,
      sleepFn: noopSleep,
      nowFn: () => now,
    });

    // Open circuit
    await assert.rejects(
      () => r.execute(async () => { throw new Error('fail'); }),
    );

    // Advance time
    now = 2000;

    // half-open attempt fails
    await assert.rejects(
      () => r.execute(async () => { throw new Error('still broken'); }),
    );
    assert.equal(r.circuitState, 'open');
  });

  it('reset clears circuit state', async () => {
    await assert.rejects(
      () => retry.execute(async () => { throw new Error('fail'); }),
    );
    assert.equal(retry.circuitState, 'open');

    retry.reset();
    assert.equal(retry.circuitState, 'closed');
    assert.equal(retry.failureCount, 0);
    assert.equal(retry.successCount, 0);
  });

  it('toJSON serializes state', () => {
    const json = retry.toJSON();
    assert.equal(json.circuitState, 'closed');
    assert.equal(json.maxRetries, 3);
    assert.equal(json.failureCount, 0);
  });

  it('error includes attempts array', async () => {
    try {
      await retry.execute(async () => { throw new Error('boom'); });
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err.attempts);
      assert.equal(err.attempts.length, 3);
      assert.equal(err.attempts[0].attempt, 1);
      assert.equal(err.attempts[0].error, 'boom');
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// 2. TransportHealthCheck
// ══════════════════════════════════════════════════════════════════════

describe('TRANSPORT_HEALTH_STATUSES', () => {
  it('is frozen with three statuses', () => {
    assert.ok(Object.isFrozen(TRANSPORT_HEALTH_STATUSES));
    assert.deepEqual(TRANSPORT_HEALTH_STATUSES, ['healthy', 'degraded', 'unhealthy']);
  });
});

describe('TransportHealthCheck', () => {
  let transport;
  let pings;
  let check;

  beforeEach(async () => {
    transport = await makeConnectedMock();
    pings = [];
    check = new TransportHealthCheck({
      transport,
      pingFn: (t) => pings.push(t),
      intervalMs: 100,
      timeoutMs: 50,
      maxMissed: 3,
    });
  });

  it('requires transport', () => {
    assert.throws(
      () => new TransportHealthCheck({ pingFn: () => {} }),
      /transport is required/,
    );
  });

  it('requires pingFn', () => {
    assert.throws(
      () => new TransportHealthCheck({ transport: {} }),
      /pingFn is required/,
    );
  });

  it('starts healthy', () => {
    assert.equal(check.status, 'healthy');
    assert.equal(check.missedCount, 0);
  });

  it('recordPong resets missed count and stays healthy', () => {
    check.recordPong();
    assert.equal(check.status, 'healthy');
    assert.equal(check.totalPongs, 1);
  });

  it('becomes degraded after 1 missed pong', () => {
    const events = [];
    check.on('degraded', () => events.push('degraded'));
    check.on('pong-timeout', () => events.push('timeout'));

    // Simulate: sendPing is called internally, but we manually trigger timeout
    // We use the internal mechanism by starting and letting timeouts fire

    // Instead, manually test the pong-timeout path:
    // Start the check, let it send a ping, wait for timeout
    check.start();

    return new Promise((resolve) => {
      setTimeout(() => {
        // After interval + timeout, should have sent a ping and timed out
        assert.ok(pings.length >= 1, 'should have sent at least one ping');
        assert.ok(check.missedCount >= 1, 'should have at least 1 missed');
        assert.ok(['degraded', 'unhealthy'].includes(check.status));
        check.stop();
        resolve();
      }, 250);
    });
  });

  it('becomes unhealthy after maxMissed consecutive timeouts', () => {
    const events = [];
    check.on('unhealthy', () => events.push('unhealthy'));

    check.start();

    return new Promise((resolve) => {
      setTimeout(() => {
        assert.equal(check.status, 'unhealthy');
        assert.ok(check.missedCount >= 3);
        assert.ok(events.includes('unhealthy'));
        check.stop();
        resolve();
      }, 600);
    });
  });

  it('recovers to healthy after recordPong', () => {
    const events = [];
    check.on('healthy', (d) => events.push(d));

    check.start();

    return new Promise((resolve) => {
      // Let it degrade first
      setTimeout(() => {
        assert.ok(check.missedCount >= 1);
        check.recordPong();
        assert.equal(check.status, 'healthy');
        assert.equal(check.missedCount, 0);
        check.stop();
        resolve();
      }, 250);
    });
  });

  it('transport getter returns the monitored transport', () => {
    assert.equal(check.transport, transport);
  });

  it('toJSON serializes state', () => {
    const json = check.toJSON();
    assert.equal(json.status, 'healthy');
    assert.equal(json.missedCount, 0);
    assert.equal(json.totalPings, 0);
  });

  it('off removes listener', () => {
    let count = 0;
    const cb = () => count++;
    check.on('ping', cb);
    check.off('ping', cb);

    check.start();
    return new Promise((resolve) => {
      setTimeout(() => {
        assert.equal(count, 0);
        check.stop();
        resolve();
      }, 150);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
// 3. ConnectionPool
// ══════════════════════════════════════════════════════════════════════

describe('ConnectionPool', () => {
  /** @type {ConnectionPool} */
  let pool;

  beforeEach(() => {
    pool = new ConnectionPool({ maxPerPeer: 3, idleTimeoutMs: 1000 });
  });

  it('starts empty', () => {
    assert.equal(pool.totalConnections, 0);
    assert.equal(pool.peerCount, 0);
  });

  it('add creates a pool entry', async () => {
    const t = await makeConnectedMock();
    assert.ok(pool.add('peer-1', t));
    assert.equal(pool.totalConnections, 1);
    assert.equal(pool.peerCount, 1);
    assert.equal(pool.countFor('peer-1'), 1);
  });

  it('add respects maxPerPeer by evicting idle', async () => {
    const transports = [];
    for (let i = 0; i < 3; i++) {
      const t = await makeConnectedMock();
      transports.push(t);
      pool.add('peer-1', t);
    }
    assert.equal(pool.countFor('peer-1'), 3);

    // Adding a 4th should evict the oldest idle
    const t4 = await makeConnectedMock();
    assert.ok(pool.add('peer-1', t4));
    assert.equal(pool.countFor('peer-1'), 3);
  });

  it('add returns false when pool is full and all acquired', async () => {
    const transports = [];
    for (let i = 0; i < 3; i++) {
      const t = await makeConnectedMock();
      transports.push(t);
      pool.add('peer-1', t);
    }

    // Acquire all
    for (let i = 0; i < 3; i++) {
      pool.acquire('peer-1');
    }

    const extra = await makeConnectedMock();
    assert.equal(pool.add('peer-1', extra), false);
  });

  it('acquire returns idle transport', async () => {
    const t = await makeConnectedMock();
    pool.add('peer-1', t);
    const acquired = pool.acquire('peer-1');
    assert.equal(acquired, t);
  });

  it('acquire returns null when no idle connections', async () => {
    const t = await makeConnectedMock();
    pool.add('peer-1', t);
    pool.acquire('peer-1');
    assert.equal(pool.acquire('peer-1'), null);
  });

  it('acquire returns null for unknown peer', () => {
    assert.equal(pool.acquire('nonexistent'), null);
  });

  it('release makes connection idle again', async () => {
    const t = await makeConnectedMock();
    pool.add('peer-1', t);
    pool.acquire('peer-1');
    assert.equal(pool.idleCountFor('peer-1'), 0);

    assert.ok(pool.release('peer-1', t));
    assert.equal(pool.idleCountFor('peer-1'), 1);
  });

  it('release returns false for unknown peer', async () => {
    const t = await makeConnectedMock();
    assert.equal(pool.release('nonexistent', t), false);
  });

  it('remove deletes a specific transport', async () => {
    const t = await makeConnectedMock();
    pool.add('peer-1', t);
    assert.ok(pool.remove('peer-1', t));
    assert.equal(pool.countFor('peer-1'), 0);
    assert.equal(pool.peerCount, 0);
  });

  it('remove returns false for unknown transport', async () => {
    const t1 = await makeConnectedMock();
    const t2 = await makeConnectedMock();
    pool.add('peer-1', t1);
    assert.equal(pool.remove('peer-1', t2), false);
  });

  it('evictIdle removes connections past idle timeout', async () => {
    let now = 1000;
    const p = new ConnectionPool({
      maxPerPeer: 5,
      idleTimeoutMs: 500,
      nowFn: () => now,
    });

    const t1 = await makeConnectedMock();
    const t2 = await makeConnectedMock();
    p.add('peer-1', t1);
    p.add('peer-1', t2);

    // Advance time past idle timeout
    now = 2000;

    const evicted = p.evictIdle();
    assert.equal(evicted, 2);
    assert.equal(p.countFor('peer-1'), 0);
  });

  it('evictIdle does not evict acquired connections', async () => {
    let now = 1000;
    const p = new ConnectionPool({
      maxPerPeer: 5,
      idleTimeoutMs: 500,
      nowFn: () => now,
    });

    const t = await makeConnectedMock();
    p.add('peer-1', t);
    p.acquire('peer-1');

    now = 2000;
    const evicted = p.evictIdle();
    assert.equal(evicted, 0);
    assert.equal(p.countFor('peer-1'), 1);
  });

  it('drainAll closes all connections', async () => {
    const closed = [];
    for (let i = 0; i < 3; i++) {
      const t = await makeConnectedMock();
      const origClose = t.close.bind(t);
      t.close = () => { closed.push(i); origClose(); };
      pool.add(`peer-${i}`, t);
    }

    pool.drainAll();
    assert.equal(closed.length, 3);
    assert.equal(pool.totalConnections, 0);
  });

  it('idleCountFor returns 0 for unknown peer', () => {
    assert.equal(pool.idleCountFor('ghost'), 0);
  });

  it('toJSON serializes pool state', async () => {
    const t = await makeConnectedMock();
    pool.add('peer-1', t);
    const json = pool.toJSON();
    assert.equal(json.maxPerPeer, 3);
    assert.equal(json.totalConnections, 1);
    assert.equal(json.peerCount, 1);
    assert.ok(json.pools['peer-1']);
    assert.equal(json.pools['peer-1'].length, 1);
    assert.equal(json.pools['peer-1'][0].acquired, false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 4. TransportMetrics
// ══════════════════════════════════════════════════════════════════════

describe('TransportMetrics', () => {
  /** @type {TransportMetrics} */
  let metrics;

  beforeEach(() => {
    metrics = new TransportMetrics('ws-peer-1');
  });

  it('requires transportId', () => {
    assert.throws(() => new TransportMetrics(''), /transportId is required/);
  });

  it('starts at zero', () => {
    assert.equal(metrics.bytesSent, 0);
    assert.equal(metrics.bytesReceived, 0);
    assert.equal(metrics.messagesSent, 0);
    assert.equal(metrics.messagesReceived, 0);
    assert.equal(metrics.errors, 0);
  });

  it('recordSend increments counters', () => {
    metrics.recordSend(128);
    metrics.recordSend(256);
    assert.equal(metrics.messagesSent, 2);
    assert.equal(metrics.bytesSent, 384);
  });

  it('recordReceive increments counters', () => {
    metrics.recordReceive(64);
    assert.equal(metrics.messagesReceived, 1);
    assert.equal(metrics.bytesReceived, 64);
  });

  it('recordError increments error count', () => {
    metrics.recordError();
    metrics.recordError();
    assert.equal(metrics.errors, 2);
  });

  it('recordLatency adds to rolling window', () => {
    metrics.recordLatency(10);
    metrics.recordLatency(20);
    metrics.recordLatency(30);
    const stats = metrics.getLatencyStats();
    assert.equal(stats.count, 3);
    assert.equal(stats.min, 10);
    assert.equal(stats.max, 30);
    assert.equal(stats.avg, 20);
  });

  it('latency window caps at maxLatencySamples', () => {
    const m = new TransportMetrics('test', { maxLatencySamples: 5 });
    for (let i = 0; i < 10; i++) {
      m.recordLatency(i * 10);
    }
    const stats = m.getLatencyStats();
    assert.equal(stats.count, 5);
    // Should contain the last 5 samples: 50, 60, 70, 80, 90
    assert.equal(stats.min, 50);
    assert.equal(stats.max, 90);
  });

  it('getLatencyStats returns zeros when empty', () => {
    const stats = metrics.getLatencyStats();
    assert.equal(stats.count, 0);
    assert.equal(stats.min, 0);
    assert.equal(stats.avg, 0);
  });

  it('getLatencyStats computes percentiles', () => {
    for (let i = 1; i <= 100; i++) {
      metrics.recordLatency(i);
    }
    const stats = metrics.getLatencyStats();
    // Values are 1..100, index = floor(count * percentile)
    assert.equal(stats.p50, 51);  // index 50 -> value 51
    assert.equal(stats.p95, 96);  // index 95 -> value 96
    assert.equal(stats.p99, 100); // index 99 -> value 100
  });

  it('reset clears all counters', () => {
    metrics.recordSend(100);
    metrics.recordReceive(200);
    metrics.recordError();
    metrics.recordLatency(50);
    metrics.reset();

    assert.equal(metrics.bytesSent, 0);
    assert.equal(metrics.bytesReceived, 0);
    assert.equal(metrics.messagesSent, 0);
    assert.equal(metrics.messagesReceived, 0);
    assert.equal(metrics.errors, 0);
    assert.equal(metrics.getLatencyStats().count, 0);
  });

  it('toJSON includes all fields', () => {
    metrics.recordSend(100);
    metrics.recordLatency(25);
    const json = metrics.toJSON();
    assert.equal(json.transportId, 'ws-peer-1');
    assert.equal(json.bytesSent, 100);
    assert.equal(json.messagesSent, 1);
    assert.ok(json.latency);
    assert.ok(json.uptimeMs >= 0);
  });

  it('transportId getter works', () => {
    assert.equal(metrics.transportId, 'ws-peer-1');
  });
});

describe('MetricsRegistry', () => {
  /** @type {MetricsRegistry} */
  let registry;

  beforeEach(() => {
    registry = new MetricsRegistry();
  });

  it('starts empty', () => {
    assert.equal(registry.size, 0);
  });

  it('getOrCreate creates new metrics', () => {
    const m = registry.getOrCreate('ws-1');
    assert.ok(m instanceof TransportMetrics);
    assert.equal(registry.size, 1);
  });

  it('getOrCreate returns same instance on second call', () => {
    const m1 = registry.getOrCreate('ws-1');
    const m2 = registry.getOrCreate('ws-1');
    assert.equal(m1, m2);
  });

  it('get returns null for unknown id', () => {
    assert.equal(registry.get('nonexistent'), null);
  });

  it('get returns existing metrics', () => {
    const m = registry.getOrCreate('ws-1');
    assert.equal(registry.get('ws-1'), m);
  });

  it('remove deletes metrics', () => {
    registry.getOrCreate('ws-1');
    assert.ok(registry.remove('ws-1'));
    assert.equal(registry.size, 0);
    assert.equal(registry.get('ws-1'), null);
  });

  it('toJSON serializes all metrics', () => {
    registry.getOrCreate('ws-1').recordSend(100);
    registry.getOrCreate('ws-2').recordReceive(200);
    const json = registry.toJSON();
    assert.ok(json['ws-1']);
    assert.ok(json['ws-2']);
    assert.equal(json['ws-1'].bytesSent, 100);
    assert.equal(json['ws-2'].bytesReceived, 200);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 5. TransportFailover
// ══════════════════════════════════════════════════════════════════════

describe('TransportFailover', () => {
  /** @type {MeshTransportNegotiator} */
  let negotiator;
  let endpoints;

  beforeEach(() => {
    negotiator = new MeshTransportNegotiator();
    endpoints = { webrtc: 'rtc://peer', 'wsh-ws': 'ws://peer' };

    negotiator.registerAdapter('webrtc', async (ep) => {
      const t = new MockMeshTransport('webrtc');
      await t.connect(ep);
      return t;
    });
    negotiator.registerAdapter('wsh-ws', async (ep) => {
      const t = new MockMeshTransport('wsh-ws');
      await t.connect(ep);
      return t;
    });
  });

  it('requires negotiator', () => {
    assert.throws(
      () => new TransportFailover({ endpoints }),
      /negotiator is required/,
    );
  });

  it('requires endpoints', () => {
    assert.throws(
      () => new TransportFailover({ negotiator }),
      /endpoints is required/,
    );
  });

  it('connect establishes initial transport', async () => {
    const failover = new TransportFailover({ negotiator, endpoints });
    const transport = await failover.connect();
    assert.ok(transport);
    assert.equal(transport.type, 'webrtc'); // preferred
    assert.equal(failover.activeTransport, transport);
  });

  it('connect fires connected event', async () => {
    const failover = new TransportFailover({ negotiator, endpoints });
    const events = [];
    failover.on('connected', (d) => events.push(d));

    await failover.connect();
    assert.equal(events.length, 1);
    assert.ok(events[0].transport);
  });

  it('failover switches to next transport type', async () => {
    const failover = new TransportFailover({ negotiator, endpoints });
    await failover.connect();
    assert.equal(failover.activeTransport.type, 'webrtc');

    const newTransport = await failover.failover('test failure');
    assert.equal(newTransport.type, 'wsh-ws');
    assert.deepEqual(failover.failedTypes, ['webrtc']);
  });

  it('failover fires events', async () => {
    const failover = new TransportFailover({ negotiator, endpoints });
    const events = [];
    failover.on('failover-start', (d) => events.push({ type: 'start', ...d }));
    failover.on('failover-complete', (d) => events.push({ type: 'complete', ...d }));

    await failover.connect();
    await failover.failover('network error');

    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'start');
    assert.equal(events[0].reason, 'network error');
    assert.equal(events[0].previousType, 'webrtc');
    assert.equal(events[1].type, 'complete');
  });

  it('failover throws when all transports exhausted', async () => {
    const failover = new TransportFailover({ negotiator, endpoints });
    await failover.connect();
    await failover.failover(); // webrtc -> wsh-ws

    await assert.rejects(
      () => failover.failover(), // wsh-ws -> nothing
      /No transports available/,
    );
  });

  it('failover fires failover-failed event on exhaustion', async () => {
    const failover = new TransportFailover({ negotiator, endpoints });
    const events = [];
    failover.on('failover-failed', (d) => events.push(d));

    await failover.connect();
    await failover.failover();
    await assert.rejects(() => failover.failover());
    assert.equal(events.length, 1);
  });

  it('concurrent failover throws', async () => {
    const failover = new TransportFailover({ negotiator, endpoints });
    await failover.connect();

    // Use a slow adapter so the failover is still in progress
    negotiator.registerAdapter('wsh-ws', async (ep) => {
      await new Promise(r => setTimeout(r, 100));
      const t = new MockMeshTransport('wsh-ws');
      await t.connect(ep);
      return t;
    });

    const p1 = failover.failover();
    await assert.rejects(
      () => failover.failover(),
      /Failover already in progress/,
    );
    await p1;
  });

  it('resetFailedTypes clears the exclusion list', async () => {
    const failover = new TransportFailover({ negotiator, endpoints });
    await failover.connect();
    await failover.failover();

    assert.equal(failover.failedTypes.length, 1);
    failover.resetFailedTypes();
    assert.equal(failover.failedTypes.length, 0);
  });

  it('works with RetryWithBackoff', async () => {
    let negotiateAttempts = 0;

    // Both adapters fail on the first negotiate() call, succeed on the second
    negotiator.registerAdapter('webrtc', async () => {
      negotiateAttempts++;
      if (negotiateAttempts <= 2) throw new Error('transient failure');
      const t = new MockMeshTransport('webrtc');
      await t.connect('test');
      return t;
    });
    negotiator.registerAdapter('wsh-ws', async () => {
      if (negotiateAttempts <= 2) throw new Error('transient failure');
      const t = new MockMeshTransport('wsh-ws');
      await t.connect('test');
      return t;
    });

    const retry = new RetryWithBackoff({ maxRetries: 3, sleepFn: noopSleep });
    const failover = new TransportFailover({ negotiator, endpoints, retry });
    const transport = await failover.connect();
    // First negotiate() fails both adapters; second succeeds with webrtc
    assert.equal(transport.type, 'webrtc');
  });

  it('toJSON serializes state', async () => {
    const failover = new TransportFailover({ negotiator, endpoints });
    await failover.connect();

    const json = failover.toJSON();
    assert.equal(json.activeTransportType, 'webrtc');
    assert.deepEqual(json.failedTypes, []);
    assert.equal(json.failingOver, false);
  });

  it('off removes listener', async () => {
    const failover = new TransportFailover({ negotiator, endpoints });
    let count = 0;
    const cb = () => count++;
    failover.on('connected', cb);
    failover.off('connected', cb);
    await failover.connect();
    assert.equal(count, 0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Integration: combining hardening primitives
// ══════════════════════════════════════════════════════════════════════

describe('Integration', () => {
  it('retry + pool + metrics + failover work together', async () => {
    const negotiator = new MeshTransportNegotiator();
    negotiator.registerAdapter('webrtc', async (ep) => {
      const t = new MockMeshTransport('webrtc');
      await t.connect(ep);
      return t;
    });
    negotiator.registerAdapter('wsh-ws', async (ep) => {
      const t = new MockMeshTransport('wsh-ws');
      await t.connect(ep);
      return t;
    });

    const retry = new RetryWithBackoff({ maxRetries: 3, sleepFn: noopSleep });
    const pool = new ConnectionPool({ maxPerPeer: 2 });
    const registry = new MetricsRegistry();

    const failover = new TransportFailover({
      negotiator,
      endpoints: { webrtc: 'rtc://peer', 'wsh-ws': 'ws://peer' },
      retry,
    });

    // Connect
    const transport = await failover.connect();
    assert.ok(transport.connected);

    // Pool it
    pool.add('peer-1', transport);
    assert.equal(pool.countFor('peer-1'), 1);

    // Track metrics
    const m = registry.getOrCreate(`${transport.type}-peer-1`);
    m.recordSend(128);
    m.recordLatency(15);

    // Failover
    const newTransport = await failover.failover('test');
    assert.equal(newTransport.type, 'wsh-ws');
    pool.add('peer-1', newTransport);
    assert.equal(pool.countFor('peer-1'), 2);

    // Verify metrics
    assert.equal(m.bytesSent, 128);
    assert.equal(m.getLatencyStats().avg, 15);

    pool.drainAll();
  });
});
