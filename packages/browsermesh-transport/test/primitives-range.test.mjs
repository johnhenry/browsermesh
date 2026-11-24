// Run with: node --import ./test/_setup-globals.mjs --test test/primitives-range.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as primitives from '@johnhenry/browsermesh-primitives';

// #231: padding shipped in primitives 0.3.0, and the shared key conversions
// (podIdToFingerprint, fingerprintToPodId; one copy, #334) in 0.6.0, which
// transport re-exports. The peer range must not admit a release without them.
describe('primitives peer range (#231, #334)', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

  it('requires primitives >=0.6.0', () => {
    const range = pkg.peerDependencies['@johnhenry/browsermesh-primitives'];
    assert.match(range, /^>=0\.6\.0\b/);
  });

  it('the primitives in use export the key conversions transport re-exports', () => {
    assert.equal(typeof primitives.podIdToFingerprint, 'function');
    assert.equal(typeof primitives.fingerprintToPodId, 'function');
  });

  it('the primitives in use export padTo and unpad', () => {
    assert.equal(typeof primitives.padTo, 'function');
    assert.equal(typeof primitives.unpad, 'function');
  });
});
