// Run with: node --import ./test/_setup-globals.mjs --test test/wsh-pairing.test.mjs
//
// How a waiting host half is handed to wsh (src/wsh-pairing.mjs): with wsh 0.54.1 `accept(socket, { waitForPeer })` gets the relay's
// paired signal; with an older wsh (no `watchPairing`) the socket is accepted as it is and the host carries `loginTimeoutMs: 0` instead.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadWatchPairing, waitingHalf } from '../src/wsh-pairing.mjs';

describe('wsh pairing: handing a waiting half to wsh', () => {
  it('an older wsh (no watchPairing): the socket as it is, no waitForPeer', () => {
    const socket = { name: 'half' };
    const half = waitingHalf(socket, null);
    assert.equal(half.socket, socket);
    assert.deepEqual(half.options, {});
  });

  it('wsh 0.54.1: the watched socket and the relay\'s paired signal as waitForPeer', async () => {
    const watchPairing = await loadWatchPairing();
    assert.equal(typeof watchPairing, 'function', 'the installed wsh has watchPairing');
    const socket = new EventTarget();
    const half = waitingHalf(socket, watchPairing);
    assert.notEqual(half.socket, undefined);
    assert.ok(half.options.waitForPeer instanceof Promise, 'waitForPeer is the paired promise');
  });

  it('the specifier of the lazy import is a literal', () => {
    const text = readFileSync(fileURLToPath(new URL('../src/wsh-pairing.mjs', import.meta.url)), 'utf8');
    const dynamic = [...text.matchAll(/\bimport\(\s*([^)\s][^)]*)\)/g)].map((m) => m[1].trim());
    assert.deepEqual(dynamic, ["'@johnhenry/wsh/pipe-relay'"]);
  });
});
