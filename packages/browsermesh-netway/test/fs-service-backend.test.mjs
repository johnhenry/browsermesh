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
});
