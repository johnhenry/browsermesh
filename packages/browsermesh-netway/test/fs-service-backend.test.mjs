import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FsServiceBackend } from '../src/fs-service-backend.mjs';

// Minimal in-memory stand-in for an OPFS root directory.
function fakeRoot() {
  const files = new Map();
  return {
    files,
    async getFileHandle(name) {
      return {
        async createWritable() {
          return {
            async write(data) { files.set(name, new Uint8Array(data)); },
            async close() {},
          };
        },
        async getFile() {
          const bytes = files.get(name);
          return { async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length); } };
        },
      };
    },
  };
}

const enc = new TextEncoder();

async function readMessage(socket) {
  const parts = [];
  let total = 0;
  while (true) {
    const c = await socket.read();
    parts.push(c);
    total += c.length;
    try {
      const all = new Uint8Array(total);
      let off = 0;
      for (const p of parts) { all.set(p, off); off += p.length; }
      return JSON.parse(new TextDecoder().decode(all));
    } catch { /* more to come */ }
  }
}

describe('FsServiceBackend', () => {
  it('accepts a write command larger than the socket window', async () => {
    const root = fakeRoot();
    const socket = await new FsServiceBackend(root).connect('fs');
    const data = new Uint8Array(700 * 1024).map((_, i) => i % 251);
    const b64 = Buffer.from(data).toString('base64');

    await socket.write(enc.encode(JSON.stringify({ op: 'write', path: 'big.bin', data: b64 })));
    assert.deepEqual(await readMessage(socket), { written: data.length });
    assert.deepEqual(root.files.get('big.bin'), data);

    await socket.close();
  });

  it('a message of exactly one window and of exact multiples of the window parses', async () => {
    for (const windows of [1, 2, 5]) {
      const root = fakeRoot();
      const socket = await new FsServiceBackend(root).connect('fs');
      const window = socket.windowBytes;
      // `{"op":"write","path":"w.bin","data":"..."}` padded with base64 to exactly N windows.
      const tail = '"}';
      // Pad the path so the base64 body is a whole number of quanta.
      let path = 'w.bin';
      while ((window * windows - `{"op":"write","path":"${path}","data":"`.length - tail.length) % 4 !== 0) path += 'x';
      const head = `{"op":"write","path":"${path}","data":"`;
      const fill = window * windows - head.length - tail.length;
      const b64 = 'QUJD'.repeat(fill / 4);
      const message = head + b64 + tail;
      assert.equal(message.length, window * windows);
      await socket.write(enc.encode(message));
      assert.equal((await readMessage(socket)).written, Buffer.from(b64, 'base64').length);
      await socket.close();
    }
  });

  it('refuses a message larger than maxMessageBytes with an error reply and closes, holding bounded memory', async () => {
    const root = fakeRoot();
    const socket = await new FsServiceBackend(root, { maxMessageBytes: 4096 }).connect('fs');
    const window = socket.windowBytes;
    let written = 0;
    const writer = (async () => {
      try {
        await socket.write(enc.encode(`{"op":"write","path":"x","data":"${'A'.repeat(window)}`));
        written += window;
        for (let i = 0; i < 64; i += 1) { await socket.write(enc.encode('A'.repeat(window))); written += window; }
      } catch { /* the backend closed */ }
    })();
    const reply = await readMessage(socket);
    assert.match(reply.error, /larger than 4096 bytes/);
    await writer;
    // It stopped reading at the bound, within a window or two, instead of taking all 64.
    assert.ok(written < 8 * window, `${written} bytes were accepted`);
    assert.equal(root.files.size, 0);
  });

  it('the default bound is 16 MiB and leaves ordinary writes alone', async () => {
    const root = fakeRoot();
    const socket = await new FsServiceBackend(root).connect('fs');
    const data = new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 251);
    await socket.write(enc.encode(JSON.stringify({ op: 'write', path: 'three.bin', data: Buffer.from(data).toString('base64') })));
    assert.deepEqual(await readMessage(socket), { written: data.length });
    await socket.close();
  });
});
