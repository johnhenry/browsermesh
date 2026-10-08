// Run with: node --import ./test/_setup-globals.mjs --test test/primitives-range.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as primitives from '@johnhenry/browsermesh-primitives';

// #231: padding shipped in primitives 0.3.0, so the peer range must not admit
// older releases and the padding helpers can be imported by name.
describe('primitives peer range (#231)', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

  it('requires primitives >=0.3.0', () => {
    const range = pkg.peerDependencies['@johnhenry/browsermesh-primitives'];
    assert.match(range, /^>=0\.3\.0\b/);
  });

  it('the primitives in use export padTo and unpad', () => {
    assert.equal(typeof primitives.padTo, 'function');
    assert.equal(typeof primitives.unpad, 'function');
  });
});
