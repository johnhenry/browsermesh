/**
 * GatewayBackend and wsh's `gateway-credit` flow control, against the mock client.
 *
 * gateway-real-wsh.test.mjs moves megabytes through a real host. This file reaches what a real host will not
 * produce on request: credit withheld for as long as the test likes, a host that does not state the feature,
 * and every way a wait for credit can end.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GatewayBackend } from '../src/gateway-backend.mjs';
import { GATEWAY_ERROR } from '../src/constants.mjs';
import { MockWshClient } from './mock-wsh-transport.mjs';

const WINDOW = 262_144;
const tick = () => new Promise((r) => setTimeout(r, 0));
const sum = (msgs, field) => msgs.reduce((n, m) => n + m[field], 0);
const sentBytes = (client) => client.findSent(0x7e).reduce((n, m) => n + m.data.length, 0);

/** A backend on a mock host that states (or not) `gateway-credit`, and one open connection. */
async function open({ credit = true, client = new MockWshClient({ features: credit ? ['gateway-credit'] : [] }) } = {}) {
  const backend = new GatewayBackend({ wshClient: client });
  const connecting = backend.connect('example.com', 80);
  await tick();
  const gatewayId = client.lastSent.gateway_id;
  client.inject({ type: 0x73, gateway_id: gatewayId });
  const socket = await connecting;
  return { client, backend, socket, gatewayId };
}

describe('GatewayBackend with gateway-credit: sending', () => {
  it('sends no more than the host\'s credit, in frames of at most 64 KiB, and goes on when more arrives', async () => {
    const { client, backend, socket, gatewayId } = await open();
    const write = socket.write(new Uint8Array(600_000).fill(9));
    await tick();
    assert.equal(sentBytes(client), WINDOW, 'exactly the initial credit is sent');
    assert.ok(client.findSent(0x7e).every((m) => m.data.length <= 65_536));
    await tick();
    assert.equal(sentBytes(client), WINDOW, 'nothing more without credit');

    client.inject({ type: 0x7f, gateway_id: gatewayId, bytes: 100_000 });
    await tick();
    assert.equal(sentBytes(client), WINDOW + 100_000);

    client.inject({ type: 0x7f, gateway_id: gatewayId, bytes: 1_000_000 });
    await write;
    await tick();
    assert.equal(sentBytes(client), 600_000);
    await backend.close();
  });

  it('credit granted for one connection does not release another', async () => {
    const a = await open();
    const c = a.client;
    const connecting = a.backend.connect('example.com', 81);
    await tick();
    const secondId = c.lastSent.gateway_id;
    c.inject({ type: 0x73, gateway_id: secondId });
    const second = await connecting;

    void a.socket.write(new Uint8Array(400_000));
    await tick();
    assert.equal(sentBytes(c), WINDOW);
    c.inject({ type: 0x7f, gateway_id: secondId, bytes: 500_000 });
    await tick();
    assert.equal(sentBytes(c), WINDOW, 'the grant was for the other connection');
    void second;
    await a.backend.close();
  });

  it('a connection accepted from a listener is metered too', async () => {
    const client = new MockWshClient({ features: ['gateway-credit'] });
    const backend = new GatewayBackend({ wshClient: client });
    const listening = backend.listen(0);
    await tick();
    client.inject({ type: 0x7b, listener_id: client.lastSent.listener_id, actual_port: 4000 });
    const listener = await listening;
    client.inject({ type: 0x76, listener_id: 1, channel_id: 5, peer_addr: '1.2.3.4', peer_port: 9 });
    const socket = await listener.accept();
    const accept = client.findSent(0x77)[0];
    void socket.write(new Uint8Array(500_000));
    await tick();
    assert.equal(sentBytes(client), WINDOW);
    assert.equal(client.findSent(0x7e)[0].gateway_id, accept.gateway_id);
    await backend.close();
  });

  it('against a host that does not state the feature nothing is metered and no credit message is ever sent', async () => {
    const { client, backend, socket, gatewayId } = await open({ credit: false });
    await socket.write(new Uint8Array(600_000).fill(1));
    await tick();
    assert.equal(sentBytes(client), 600_000, 'all of it went out with no credit');
    client.inject({ type: 0x7e, gateway_id: gatewayId, data: new Uint8Array(200_000) });
    client.inject({ type: 0x7e, gateway_id: gatewayId, data: new Uint8Array(200_000) });
    await socket.read();
    await tick();
    assert.equal(client.findSent(0x7f).length, 0);
    await backend.close();
  });

  it('against such a host a consumer that does not read is cut off at the chunk cap (as before credit existed), not buffered without bound', async () => {
    const { client, backend, socket, gatewayId } = await open({ credit: false });
    for (let i = 0; i < 1500; i++) client.inject({ type: 0x7e, gateway_id: gatewayId, data: new Uint8Array(1000) });
    await tick();
    let chunks = 0;
    while ((await socket.read()) !== null) chunks++;
    assert.equal(chunks, 1024, 'what was queued before the cap is read, then end of stream');
    await backend.close();
  });

  it('a client with no hasFeature() at all is served as before', async () => {
    const client = new MockWshClient();
    client.hasFeature = undefined;
    const { backend, socket } = await open({ client });
    await socket.write(new Uint8Array(600_000));
    await tick();
    assert.equal(sentBytes(client), 600_000);
    await backend.close();
  });
});

describe('GatewayBackend with gateway-credit: receiving', () => {
  it('returns credit as the consumer reads, not as bytes arrive', async () => {
    const { client, backend, socket, gatewayId } = await open();
    const credited = () => sum(client.findSent(0x7f), 'bytes');
    for (let i = 0; i < 4; i++) client.inject({ type: 0x7e, gateway_id: gatewayId, data: new Uint8Array(100_000) });
    await tick();
    // 400,000 arrived; the socket's window (262,144) took 200,000 whole pieces and part of the third.
    assert.ok(socket.readableLength <= WINDOW, `${socket.readableLength} buffered, window ${WINDOW}`);
    assert.equal(credited(), 200_000, 'credit went back only for what the socket took in');
    assert.ok(client.findSent(0x7f).every((m) => m.gateway_id === gatewayId));

    let read = 0;
    while (read < 400_000) read += (await socket.read()).length;
    await tick();
    assert.equal(credited(), 400_000, 'the rest was returned once the consumer read');
    await backend.close();
  });

  it('a consumer that never reads makes the backend stop returning credit', async () => {
    const { client, backend, gatewayId } = await open();
    // A host that honours its credit sends at most WINDOW bytes; model it sending exactly that, then waiting.
    for (let i = 0; i < 4; i++) client.inject({ type: 0x7e, gateway_id: gatewayId, data: new Uint8Array(65_536) });
    await tick();
    const credited = sum(client.findSent(0x7f), 'bytes');
    assert.ok(credited <= WINDOW);
    assert.equal(credited, 262_144, 'the window took it all');
    // ...and now the window is full: more data would wait, and no credit goes out for it.
    client.inject({ type: 0x7e, gateway_id: gatewayId, data: new Uint8Array(65_536) });
    await tick();
    assert.equal(sum(client.findSent(0x7f), 'bytes'), credited);
    await backend.close();
  });
});

describe('GatewayBackend with gateway-credit: a wait for credit ends', () => {
  /** A write that is parked waiting for credit. */
  async function parked() {
    const ctx = await open();
    const write = ctx.socket.write(new Uint8Array(900_000));
    const outcome = write.then(() => 'resolved', (e) => e);
    await tick();
    assert.equal(sentBytes(ctx.client), WINDOW);
    return { ...ctx, outcome };
  }

  it('when the host discards the connection (a GatewayClose with the reason "discarded")', async () => {
    const { client, gatewayId, outcome, socket, backend } = await parked();
    client.inject({ type: 0x75, gateway_id: gatewayId, reason: 'discarded' });
    const result = await outcome;
    assert.equal(result.name, 'SocketClosedError');
    assert.equal(await socket.read(), null);
    await backend.close();
  });

  it('not when the host merely half-closes: the host still reads, and grants credit as its origin takes the bytes', async () => {
    const { client, gatewayId, outcome, socket, backend } = await parked();
    client.inject({ type: 0x75, gateway_id: gatewayId });
    assert.equal(await socket.read(), null, 'the application sees the host\'s end');
    client.inject({ type: 0x7f, gateway_id: gatewayId, bytes: 1_000_000 });
    assert.equal(await outcome, 'resolved');
    await tick();
    assert.equal(sentBytes(client), 900_000);
    await backend.close();
  });

  it('when the user destroys the socket; the host is told the channel is done', async () => {
    const { client, gatewayId, outcome, socket, backend } = await parked();
    socket.destroy();
    const result = await outcome;
    assert.equal(result.name, 'SocketClosedError');
    await tick();
    assert.deepEqual(client.findSent(0x75).map((m) => m.gateway_id), [gatewayId]);
    await backend.close();
  });

  it('when the backend is closed', async () => {
    const { outcome, backend } = await parked();
    await backend.close();
    assert.equal((await outcome).name, 'SocketClosedError');
  });

  it('when the wsh client\'s transport closes; the handler that was already there still runs', async () => {
    const client = new MockWshClient({ features: ['gateway-credit'] });
    let previousCalled = null;
    client.onClose = (info) => { previousCalled = info; };
    const ctx = await open({ client });
    const outcome = ctx.socket.write(new Uint8Array(900_000)).then(() => 'resolved', (e) => e);
    await tick();
    client.onClose({ code: 1006 });
    assert.equal((await outcome).name, 'SocketClosedError');
    assert.deepEqual(previousCalled, { code: 1006 });
    assert.equal(await ctx.socket.read(), null, 'a read does not hang either');
    await ctx.backend.close();
  });

  it('when sending fails, and the host is not told anything over the dead transport', async () => {
    const { client, outcome, socket, backend } = await parked();
    client.inject({ type: 0x7f, gateway_id: client.findSent(0x7e)[0].gateway_id, bytes: 10 });
    client.sendControl = async () => { throw new Error('transport dead'); };
    const result = await outcome;
    assert.equal(result.name, 'SocketClosedError');
    assert.equal(await socket.read(), null);
    await backend.close();
  });
});

describe('GatewayBackend with gateway-credit: failure codes keep their mapping', () => {
  async function fail(code, message) {
    const client = new MockWshClient({ features: ['gateway-credit'] });
    const backend = new GatewayBackend({ wshClient: client });
    const connecting = backend.connect('example.com', 80);
    await tick();
    client.inject({ type: 0x74, gateway_id: client.lastSent.gateway_id, code, message });
    const err = await connecting.then(() => null, (e) => e);
    await backend.close();
    return err;
  }

  it('8 is an OperationTimeoutError', async () => {
    const err = await fail(GATEWAY_ERROR.TIMEOUT, 'too slow');
    assert.equal(err.name, 'OperationTimeoutError');
    assert.match(err.message, /code: 8/);
  });

  it('5 is a ConnectionRefusedError that says it may be a disabled gateway or an older gateway\'s timeout', async () => {
    const err = await fail(GATEWAY_ERROR.GATEWAY_DISABLED, 'no');
    assert.equal(err.name, 'ConnectionRefusedError');
    assert.match(err.message, /gateway is disabled, or a timeout from an older gateway/);
  });
});
