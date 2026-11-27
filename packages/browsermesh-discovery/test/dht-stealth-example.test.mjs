// Run with: node --import ./test/_setup-globals.mjs --test test/dht-stealth-example.test.mjs
//
// CI runs `npm test`, not `npm run examples`, so this is what keeps
// examples/27-dht-and-stealth-records.mjs from rotting: it runs the example
// and requires it to finish and print its key lines (same convention as
// browsermesh-transport's wsh-example.test.mjs for example 18).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const example = fileURLToPath(new URL('../../../examples/27-dht-and-stealth-records.mjs', import.meta.url));

describe('examples/27-dht-and-stealth-records.mjs', () => {
  it('runs to completion and prints its key lines', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [example], { timeout: 30_000 });
    assert.match(stdout, /ok: DHT lookups, owned stores, parity-protected shards and swarm membership behaved as designed/);
    for (const step of [
      'ALLOWED  signed store by the key owner',
      'REFUSED  forged store: not-key-owner',
      'ALLOWED  recovered with 2 of 5 holders lost',
      'REFUSED  recovery with 3 of 5 holders lost: unavailable',
      'a chain of seeds still gives every pod the full view',
      'pod-a let pod-d leave',
      'pod-c went silent and was dropped',
    ]) {
      assert.ok(stdout.includes(step), `missing: ${step}`);
    }
  });
});
