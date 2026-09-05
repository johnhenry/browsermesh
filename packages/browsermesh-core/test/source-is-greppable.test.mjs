// Run with: node --import ./test/_setup-globals.mjs --test test/source-is-greppable.test.mjs
//
// Every source file must be text that grep will actually read.
//
// src/handshake.mjs carried a raw NUL byte -- the single-use token replay key
// was written as `${token.podId}<NUL>${token.nonce}` with the byte inlined
// rather than as a backslash-u-0000 escape. One byte, no runtime effect, and it made
// `file` report the module as `data`.
//
// The cost is that grep treats such a file as binary and skips it *silently*.
// Not an error, not a warning -- an empty result, which reads exactly like
// "this pattern does not occur". Every search over src/ quietly excluded the
// module holding the pairing and token logic:
//
//     $ grep -c "^export class" src/handshake.mjs   ->  0
//     $ grep -ac "^export class" src/handshake.mjs  ->  4
//
// Issue #5 reported `grep -rn sdp packages/browsermesh-core/src/` returning
// zero occurrences as evidence about this very file. The conclusion happened
// to be right, but the grep that produced it could not have found a match if
// one existed. Anything else built on a source grep -- an audit for a banned
// API, a CI guard, a reviewer checking whether a symbol is used -- had the
// same blind spot in the same file.
//
// So this is a tooling invariant, not a style rule: a source file that grep
// cannot read is a file every text-based check silently passes.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const packagesDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** Every .mjs under packages/, excluding installed dependencies. */
function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith('.mjs')) out.push(full);
  }
  return out;
}

describe('source files are readable by text tooling', () => {
  it('no .mjs file contains a NUL byte', () => {
    const files = sourceFiles(packagesDir);

    // Guard the guard: a walk that finds nothing would pass this test while
    // checking nothing at all, which is the same failure mode as the bug.
    assert.ok(files.length > 20, `expected to walk many sources, found ${files.length}`);

    const offenders = files
      .filter((f) => readFileSync(f).includes(0x00))
      .map((f) => relative(packagesDir, f));

    assert.deepEqual(
      offenders,
      [],
      `these files contain a raw NUL byte, so grep skips them silently. ` +
      `Write the byte as the \\u0000 escape instead -- identical at runtime, ` +
      `and the file stays text.`
    );
  });

  it('the token replay key still separates its fields with a NUL character', async () => {
    // The escape must not be "fixed" into a visible character: the separator
    // exists so a podId cannot be crafted to collide with a nonce boundary,
    // and NUL is the one byte neither field can contain.
    const source = readFileSync(
      join(packagesDir, 'browsermesh-core', 'src', 'handshake.mjs'),
      'utf8'
    );
    assert.match(
      source,
      /\$\{token\.podId\}\\u0000\$\{token\.nonce\}/,
      'the replay key must keep a NUL separator, written as an escape'
    );
  });
});
