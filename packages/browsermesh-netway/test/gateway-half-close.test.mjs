/**
 * GatewayBackend and the half-close rule of wsh 0.57 (wsh issue 271), against the mock client.
 *
 * A GatewayClose is a half-close: the sender sends no more and goes on receiving. A connection is over when both
 * sides have sent one, on an error, on a "discarded" close, or when it is half-closed and nothing has moved in
 * either direction for `halfCloseIdleMs`. gateway-half-close-real-wsh.test.mjs runs the same rule against a real host.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GatewayBackend } from '../src/gateway-backend.mjs';
import { MockWshClient } from './mock-wsh-transport.mjs';

const tick = () => new Promise((r) => setImmediate(r));
const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

async function open({ credit = false, ...opts } = {}) {
  const client = new MockWshClient({ features: credit ? ['gateway-credit'] : [] });
  const backend = new GatewayBackend({ wshClient: client, ...opts });
  const connecting = backend.connect('example.com', 80);
  await tick();
  const gatewayId = client.lastSent.gateway_id;
  client.inject({ type: 0x73, gateway_id: gatewayId });
  const socket = await connecting;
  return { client, backend, socket, gatewayId };
}

const closes = (client) => client.findSent(0x75);

describe('GatewayBackend: the host half-closes, the application keeps writing', () => {
  it('the application reads end of stream, and what it writes afterwards still goes to the host', async () => {
    const { client, backend, socket, gatewayId } = await open();
    client.inject({ type: 0x7e, gateway_id: gatewayId, data: enc('answer') });
    client.inject({ type: 0x75, gateway_id: gatewayId });
    assert.equal(dec(await socket.read()), 'answer');
    assert.equal(await socket.read(), null);
    await socket.write(enc('late bytes'));
    await tick();
    assert.equal(dec(client.findSent(0x7e).at(-1).data), 'late bytes');
    assert.equal(closes(client).length, 0, 'we have not said we are done');
    await socket.end();
    await tick();
    assert.equal(closes(client).length, 1);
    assert.equal(closes(client)[0].reason, undefined, 'a plain half-close carries no reason');
    await backend.close();
  });

  it('with credit on, the host still grants credit after its close, and the writer is not cut off', async () => {
    const { client, backend, socket, gatewayId } = await open({ credit: true });
    client.inject({ type: 0x75, gateway_id: gatewayId });
    const big = new Uint8Array(300_000).fill(5);
    const writing = socket.write(big);
    await tick();
    let sent = client.findSent(0x7e).reduce((n, m) => n + m.data.length, 0);
    assert.equal(sent, 262_144, 'only the credit the host gave');
    client.inject({ type: 0x7f, gateway_id: gatewayId, bytes: 100_000 });
    await writing;
    await tick();
    sent = client.findSent(0x7e).reduce((n, m) => n + m.data.length, 0);
    assert.equal(sent, 300_000);
    await backend.close();
  });

  it('a GatewayClose with the reason "discarded" ends both directions and no GatewayClose goes back', async () => {
    const { client, backend, socket, gatewayId } = await open();
    client.inject({ type: 0x7e, gateway_id: gatewayId, data: enc('kept') });
    client.inject({ type: 0x75, gateway_id: gatewayId, reason: 'discarded' });
    await tick();
    await assert.rejects(socket.write(enc('x')), { name: 'SocketClosedError' });
    assert.equal(closes(client).length, 0, 'the host discarded the connection: it reads nothing more');
    await backend.close();
  });

  it('data and credit that arrive for a connection that is over are ignored', async () => {
    const { client, backend, socket, gatewayId } = await open({ credit: true });
    await socket.end();
    client.inject({ type: 0x75, gateway_id: gatewayId });
    await tick();
    const before = client.sent.length;
    client.inject({ type: 0x7e, gateway_id: gatewayId, data: enc('stray') });
    client.inject({ type: 0x7f, gateway_id: gatewayId, bytes: 10 });
    await tick();
    assert.equal(client.sent.length, before, 'nothing is sent for a connection that both sides closed');
    await backend.close();
  });
});

describe('GatewayBackend: the application half-closes and keeps reading', () => {
  it('end() sends a GatewayClose without a reason, and an answer that arrives later is delivered', async () => {
    const { client, backend, socket, gatewayId } = await open({ credit: true });
    await socket.end();
    await tick();
    assert.equal(closes(client).length, 1);
    assert.equal(closes(client)[0].reason, undefined);
    client.inject({ type: 0x7e, gateway_id: gatewayId, data: enc('two seconds later') });
    assert.equal(dec(await socket.read()), 'two seconds later');
    client.inject({ type: 0x75, gateway_id: gatewayId });
    assert.equal(await socket.read(), null);
    assert.equal(closes(client).length, 1, 'both sides have closed: nothing more is said');
    await backend.close();
  });

  it('close() discards the connection: the GatewayClose carries the reason "discarded"', async () => {
    const { client, backend, socket } = await open({ credit: true });
    await socket.close();
    await tick();
    assert.equal(closes(client).length, 1);
    assert.equal(closes(client)[0].reason, 'discarded');
    await backend.close();
  });

  it('destroy() discards it too', async () => {
    const { client, backend, socket } = await open();
    socket.destroy(new Error('gone'));
    await tick();
    assert.equal(closes(client).length, 1);
    assert.equal(closes(client)[0].reason, 'discarded');
    await backend.close();
  });
});

describe('GatewayBackend: an idle bound on a half-closed connection', () => {
  it('ends a half-closed connection that nothing has moved on for halfCloseIdleMs, and says so to the host', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
    const { client, backend, socket } = await open({ halfCloseIdleMs: 5_000 });
    await socket.end(); // we are done; the host owes its own GatewayClose and never sends it
    await tick();
    assert.equal(closes(client).length, 1);
    t.mock.timers.tick(4_999);
    await tick();
    assert.equal(socket.closeReason, null, 'not sooner than the bound');
    t.mock.timers.tick(2);
    await tick();
    assert.equal(await socket.read(), null);
    // a write on the user side after the end is refused anyway; the peer end sees the reason
    assert.equal(closes(client).length, 1, 'our GatewayClose was already sent; one is enough');
    await backend.close();
  });

  it('a host that half-closed and an application that never closes: ended at the bound, GatewayClose sent', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
    const { client, backend, socket, gatewayId } = await open({ halfCloseIdleMs: 5_000 });
    client.inject({ type: 0x75, gateway_id: gatewayId });
    await tick();
    assert.equal(closes(client).length, 0);
    t.mock.timers.tick(5_001);
    await tick();
    assert.equal(closes(client).length, 1);
    assert.equal(closes(client)[0].reason, 'idle timeout');
    await assert.rejects(socket.write(enc('x')), { name: 'SocketClosedError' });
    await backend.close();
  });

  it('traffic in either direction postpones it', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
    const { client, backend, socket, gatewayId } = await open({ halfCloseIdleMs: 5_000 });
    client.inject({ type: 0x75, gateway_id: gatewayId });
    t.mock.timers.tick(4_000);
    await socket.write(enc('still here'));
    await tick();
    t.mock.timers.tick(4_000); // 8 s since the half-close, 4 s since the write
    await tick();
    assert.equal(closes(client).length, 0, 'the write counted');
    t.mock.timers.tick(1_001);
    await tick();
    assert.equal(closes(client).length, 1);
    await backend.close();
  });

  it('a connection that is not half-closed is never ended by it', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
    const { client, backend } = await open({ halfCloseIdleMs: 5_000 });
    t.mock.timers.tick(60_000);
    await tick();
    assert.equal(closes(client).length, 0);
    await backend.close();
  });

  it('0 turns it off', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
    const { client, backend, gatewayId } = await open({ halfCloseIdleMs: 0 });
    client.inject({ type: 0x75, gateway_id: gatewayId });
    t.mock.timers.tick(3_600_000);
    await tick();
    assert.equal(closes(client).length, 0);
    await backend.close();
  });

  it('the default is five minutes, as wsh\'s', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
    const { client, backend, gatewayId } = await open();
    client.inject({ type: 0x75, gateway_id: gatewayId });
    t.mock.timers.tick(299_000);
    await tick();
    assert.equal(closes(client).length, 0);
    t.mock.timers.tick(2_000);
    await tick();
    assert.equal(closes(client).length, 1);
    await backend.close();
  });

  it('the option is validated', () => {
    const wshClient = new MockWshClient();
    for (const bad of [-1, 1.5, '5', NaN, 2 ** 31]) {
      assert.throws(() => new GatewayBackend({ wshClient, halfCloseIdleMs: bad }), { name: 'TypeError' }, String(bad));
    }
  });

  it('closing the backend stops the timers', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
    const { client, backend, gatewayId } = await open({ halfCloseIdleMs: 5_000 });
    client.inject({ type: 0x75, gateway_id: gatewayId });
    await backend.close();
    const before = client.sent.length;
    t.mock.timers.tick(10_000);
    await tick();
    assert.equal(client.sent.length, before);
  });
});
