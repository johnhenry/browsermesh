// Run with: node --import ./test/_setup-globals.mjs --test test/channel-relay.test.mjs
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  ChannelRelay,
} from '../src/channel-relay.mjs';

describe('ChannelRelay', () => {
  let relay;

  beforeEach(() => {
    relay = new ChannelRelay({ port: 0 });
  });

  afterEach(() => {
    relay.stop();
  });

  // ── constructor ──────────────────────────────────────────

  it('stores config from constructor', () => {
    const r = new ChannelRelay({ port: 9090, path: '/hook' });
    assert.equal(r.config.port, 9090);
    assert.equal(r.config.path, '/hook');
  });

  it('defaults path to /webhook', () => {
    assert.equal(relay.config.path, '/webhook');
  });

  // ── createInboundMessage ─────────────────────────────────

  it('normalizes raw webhook payload', () => {
    const msg = relay.createInboundMessage({
      body: 'hello from webhook',
      sender: 'external-system',
      id: 'wh_1',
    });
    assert.equal(msg.id, 'wh_1');
    assert.equal(msg.content, 'hello from webhook');
    assert.equal(msg.sender.name, 'external-system');
    assert.equal(msg.channel, 'relay');
    assert.equal(typeof msg.timestamp, 'number');
  });

  it('generates id when missing', () => {
    const msg = relay.createInboundMessage({ body: 'test' });
    assert.ok(msg.id);
    assert.ok(msg.id.length > 0);
  });

  it('defaults sender to unknown', () => {
    const msg = relay.createInboundMessage({ body: 'anon' });
    assert.equal(msg.sender.name, 'Unknown');
  });

  // ── lifecycle ────────────────────────────────────────────

  it('start sets running to true', () => {
    relay.start();
    assert.equal(relay.running, true);
  });

  it('stop sets running to false', () => {
    relay.start();
    relay.stop();
    assert.equal(relay.running, false);
  });

  it('double stop is safe', () => {
    relay.start();
    relay.stop();
    relay.stop();
    assert.equal(relay.running, false);
  });

  // ── onMessage ────────────────────────────────────────────

  it('registers and invokes message callback', () => {
    const received = [];
    relay.onMessage((msg) => received.push(msg));
    relay.start();
    relay.handleWebhook({ body: 'test payload', sender: 'sys' });
    assert.equal(received.length, 1);
    assert.equal(received[0].content, 'test payload');
  });

  it('does not invoke callback when stopped', () => {
    const received = [];
    relay.onMessage((msg) => received.push(msg));
    // not started
    relay.handleWebhook({ body: 'ignored' });
    assert.equal(received.length, 0);
  });

  // ── sendMessage ──────────────────────────────────────────

  it('sendMessage posts to BroadcastChannel', () => {
    const posted = [];
    relay._bc = { postMessage: (m) => posted.push(m) };
    relay.start();
    relay.sendMessage('hello relay');
    assert.equal(posted.length, 1);
    assert.equal(posted[0].text, 'hello relay');
    assert.equal(posted[0].channel, 'relay');
  });

  it('sendMessage returns false when not running', () => {
    const ok = relay.sendMessage('nope');
    assert.equal(ok, false);
  });

  // ── BroadcastChannel relay ───────────────────────────────

  it('relays inbound from BroadcastChannel', () => {
    const received = [];
    relay.onMessage((msg) => received.push(msg));
    relay.start();
    // Simulate BC message
    relay._handleBcMessage({ data: { text: 'from bc', sender: 'peer' } });
    assert.equal(received.length, 1);
    assert.equal(received[0].content, 'from bc');
    assert.equal(received[0].sender.name, 'peer');
  });

  // ── route table ──────────────────────────────────────────

  it('addRoute registers a named route', () => {
    relay.addRoute('notify', (payload) => payload);
    assert.ok(relay.hasRoute('notify'));
  });

  it('removeRoute removes a named route', () => {
    relay.addRoute('temp', () => {});
    relay.removeRoute('temp');
    assert.equal(relay.hasRoute('temp'), false);
  });

  it('handleWebhook dispatches to named route', () => {
    const calls = [];
    relay.addRoute('alert', (payload) => calls.push(payload));
    relay.start();
    relay.handleWebhook({ body: 'fire', route: 'alert' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body, 'fire');
  });
});
