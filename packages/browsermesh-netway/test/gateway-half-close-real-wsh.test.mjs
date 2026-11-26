/**
 * The half-close rule of wsh 0.57 (wsh issue 271) through GatewayBackend, against a REAL wsh host and real TCP origins
 * that keep their own half open (`allowHalfOpen`).
 *
 * - an answer that arrives seconds after the requester finished sending is delivered;
 * - so is a large one;
 * - an origin that finishes first does not stop the requester from sending its last bytes;
 * - both sides finishing frees the host's slot at once;
 * - a requester that half-closes and never reads is ended by the host's idle bound, and its slot is freed.
 *
 * `@johnhenry/wsh` is a dev dependency of this package; without it the file skips.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skip, startServerHost, startOrigin, readAll } from './real-wsh-host.mjs';

const enc = (s) => new TextEncoder().encode(s);
const LATE_MS = 2_000;

describe('GatewayBackend half-close against a real wsh host', { skip }, () => {
  let host;
  before(async () => {
    host = await startServerHost({ allow: ['127.0.0.1'], allowPrivate: ['127.0.0.1'], halfCloseIdleMs: 60_000 });
  });
  after(async () => { await host?.close(); });

  it('an answer that arrives two seconds after the requester finished sending is delivered', { timeout: 20_000 }, async () => {
    const origin = await startOrigin((s) => {
      s.on('end', () => setTimeout(() => s.end('done\n'), LATE_MS));
      s.resume();
    });
    try {
      const socket = await host.backend.connect('127.0.0.1', origin.port);
      await socket.end();
      assert.equal((await readAll(socket)).toString(), 'done\n');
    } finally { await origin.close(); }
  });

  it('a large answer after the half-close arrives whole, to a reader that starts late', { timeout: 30_000 }, async () => {
    const size = 3 * 1024 * 1024;
    const payload = Buffer.alloc(size);
    for (let i = 0; i < size; i++) payload[i] = (i * 31 + 7) & 0xff;
    const origin = await startOrigin((s) => {
      s.on('end', () => s.end(payload));
      s.resume();
    });
    try {
      const socket = await host.backend.connect('127.0.0.1', origin.port);
      await socket.write(enc('request'));
      await socket.end();
      await new Promise((r) => setTimeout(r, 300)); // the answer is on its way before anyone reads
      const got = await readAll(socket);
      assert.equal(got.length, size);
      assert.ok(got.equals(payload));
    } finally { await origin.close(); }
  });

  it('an origin that finishes first still receives what the requester sends afterwards', { timeout: 20_000 }, async () => {
    const received = Promise.withResolvers();
    const origin = await startOrigin((s) => {
      const parts = [];
      s.on('data', (d) => parts.push(d));
      s.on('end', () => { received.resolve(Buffer.concat(parts).toString()); s.end(); });
      s.write('hello');
      s.end(); // its FIN, and it goes on reading
    });
    try {
      const socket = await host.backend.connect('127.0.0.1', origin.port);
      assert.equal((await readAll(socket)).toString(), 'hello', 'the origin\'s end of file is the application\'s end of stream');
      await socket.write(enc('late reply'));
      await socket.end();
      assert.equal(await received.promise, 'late reply');
    } finally { await origin.close(); }
  });

  it('a destination that closes its side and a requester that closes its side end the connection, and the slot is free', { timeout: 20_000 }, async () => {
    const own = await startServerHost({ allow: ['127.0.0.1'], allowPrivate: ['127.0.0.1'], maxConnections: 1, halfCloseIdleMs: 0 });
    const origin = await startOrigin((s) => { s.on('end', () => s.end('bye')); s.resume(); });
    try {
      const a = await own.backend.connect('127.0.0.1', origin.port);
      await a.end();
      assert.equal((await readAll(a)).toString(), 'bye');
      // both sides finished: with a cap of one, the next connection is accepted without waiting for any timer
      const b = await own.backend.connect('127.0.0.1', origin.port);
      await b.end();
      assert.equal((await readAll(b)).toString(), 'bye');
    } finally { await origin.close(); await own.close(); }
  });

  it('closing a socket (discarding it) frees the host\'s slot at once, not at the idle bound', { timeout: 20_000 }, async () => {
    const own = await startServerHost({ allow: ['127.0.0.1'], allowPrivate: ['127.0.0.1'], maxConnections: 1, halfCloseIdleMs: 0 });
    const gone = Promise.withResolvers();
    const origin = await startOrigin((s) => { s.on('end', () => gone.resolve()); s.resume(); });
    try {
      const a = await own.backend.connect('127.0.0.1', origin.port);
      await a.close();
      await gone.promise; // the origin saw the end of the connection; the host's slot is released with it (the idle bound is off)
      const b = await own.backend.connect('127.0.0.1', origin.port);
      await b.close();
    } finally { await origin.close(); await own.close(); }
  });
});

describe('GatewayBackend: a requester that half-closes and never reads, against a real wsh host', { skip }, () => {
  it('is ended by the host\'s idle bound, and the slot is freed', { timeout: 20_000 }, async () => {
    const own = await startServerHost({ allow: ['127.0.0.1'], allowPrivate: ['127.0.0.1'], maxConnections: 1, halfCloseIdleMs: 400 });
    const origin = await startOrigin((s) => { s.resume(); }); // never answers, never ends
    try {
      const a = await own.backend.connect('127.0.0.1', origin.port);
      const t0 = Date.now();
      await a.end();
      assert.equal(await a.read(), null, 'the host ended the connection');
      assert.ok(Date.now() - t0 >= 300, 'not sooner than the bound');
      const b = await own.backend.connect('127.0.0.1', origin.port);
      await b.close();
    } finally { await origin.close(); await own.close(); }
  });

  it('a requester that is merely slow to be answered is not ended while bytes move', { timeout: 20_000 }, async () => {
    const own = await startServerHost({ allow: ['127.0.0.1'], allowPrivate: ['127.0.0.1'], halfCloseIdleMs: 1_000 });
    const origin = await startOrigin((s) => {
      s.on('end', () => {
        let n = 0;
        const timer = setInterval(() => { s.write('.'); if (++n === 4) { clearInterval(timer); s.end(); } }, 400);
      });
      s.resume();
    });
    try {
      const a = await own.backend.connect('127.0.0.1', origin.port);
      await a.end();
      assert.equal((await readAll(a)).toString(), '....');
    } finally { await origin.close(); await own.close(); }
  });
});
