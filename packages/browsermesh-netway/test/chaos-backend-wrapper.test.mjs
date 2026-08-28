import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChaosBackendWrapper } from '../src/chaos-backend-wrapper.mjs';
import { ChaosEngine } from './_stubs/chaos.mjs';
import { RNG } from './_stubs/rng.mjs';
import { Clock } from './_stubs/clock.mjs';
import { StreamSocket } from '../src/stream-socket.mjs';
import { Backend } from '../src/backend.mjs';

class MockBackend extends Backend {
  connectCalls = [];
  sendCalls = [];

  async connect(host, port) {
    this.connectCalls.push({ host, port });
    const [a, b] = StreamSocket.createPair();
    return a;
  }

  async sendDatagram(host, port, data) {
    this.sendCalls.push({ host, port, data });
  }
}

describe('ChaosBackendWrapper', () => {
  it('connect passes through when chaos disabled', async () => {
    const inner = new MockBackend();
    const chaos = new ChaosEngine();
    const wrapper = new ChaosBackendWrapper(inner, chaos);

    const socket = await wrapper.connect('localhost', 8080);
    assert.equal(inner.connectCalls.length, 1);
    assert.ok(socket);
    await socket.close();
  });

  it('connect throws on partition', async () => {
    const chaos = new ChaosEngine();
    chaos.enable();
    chaos.configure({ partitionTargets: ['remote:9090'] });

    const wrapper = new ChaosBackendWrapper(new MockBackend(), chaos);
    await assert.rejects(() => wrapper.connect('remote', 9090), { name: 'ConnectionRefusedError' });
  });

  it('connect drops on shouldDrop', async () => {
    const chaos = new ChaosEngine();
    chaos.enable();
    chaos.configure({ dropRate: 1.0 });

    const inner = new MockBackend();
    const wrapper = new ChaosBackendWrapper(inner, chaos);
    await assert.rejects(() => wrapper.connect('localhost', 8080), { name: 'ConnectionRefusedError' });
    assert.equal(inner.connectCalls.length, 0);
  });

  it('connect adds latency', async () => {
    const clock = Clock.fixed(0, 0);
    const chaos = new ChaosEngine({ clock });
    chaos.enable();
    chaos.configure({ latencyMs: 50 });

    const wrapper = new ChaosBackendWrapper(new MockBackend(), chaos);
    await wrapper.connect('localhost', 8080);
    assert.equal(clock.nowMonotonic(), 50);
  });

  it('sendDatagram drops silently', async () => {
    const chaos = new ChaosEngine();
    chaos.enable();
    chaos.configure({ dropRate: 1.0 });

    const inner = new MockBackend();
    const wrapper = new ChaosBackendWrapper(inner, chaos);
    await wrapper.sendDatagram('localhost', 8080, new Uint8Array([1]));
    assert.equal(inner.sendCalls.length, 0);
  });

  it('sendDatagram passes through when no drop', async () => {
    const chaos = new ChaosEngine();
    chaos.enable();
    chaos.configure({ dropRate: 0 });

    const inner = new MockBackend();
    const wrapper = new ChaosBackendWrapper(inner, chaos);
    await wrapper.sendDatagram('localhost', 8080, new Uint8Array([1]));
    assert.equal(inner.sendCalls.length, 1);
  });

  it('per-scope chaos config', async () => {
    const chaos = new ChaosEngine();
    chaos.enable();
    chaos.configure({ dropRate: 0 });
    chaos.configureScope('scope_1', { dropRate: 1.0 });

    const inner = new MockBackend();
    const wrapper = new ChaosBackendWrapper(inner, chaos, 'scope_1');
    await assert.rejects(() => wrapper.connect('localhost', 8080), { name: 'ConnectionRefusedError' });
  });
});
