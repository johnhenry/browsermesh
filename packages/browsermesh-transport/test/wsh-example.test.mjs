// Run with: node --import ./test/_setup-globals.mjs --test test/wsh-example.test.mjs
//
// CI runs `npm test`, not `npm run examples`, so this is what keeps
// examples/17-wsh-sealed-peer-link.mjs from rotting: it runs the example and
// requires it to finish and say so.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const example = fileURLToPath(new URL('../../../examples/17-wsh-sealed-peer-link.mjs', import.meta.url));

describe('examples/17-wsh-sealed-peer-link.mjs', () => {
  it('runs to completion and prints its closing line', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [example], { timeout: 60_000 });
    assert.match(stdout, /ok: a mesh link over wsh is authenticated both ways and sealed against the relay/);
    for (const step of ['linked over wsh', 'delivered both ways', 'none of them contain the message', 'refused: WSH_REFUSED', 'nothing forged was delivered']) {
      assert.ok(stdout.includes(step), `missing: ${step}`);
    }
  });
});
