/**
 * Tests for serverless-peer-select.mjs (Phase 5 of the BrowserMesh
 * Serverless plan -- see that file's own module doc comment).
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/serverless-peer-select.test.mjs
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { selectPeer } from '../src/serverless-peer-select.mjs'

describe('selectPeer', () => {
  it('returns null for an empty candidate list', () => {
    assert.equal(selectPeer([], 'first-fit'), null)
    assert.equal(selectPeer([]), null)
  })

  it('first-fit always picks the first candidate', () => {
    const candidates = [{ podId: 'a' }, { podId: 'b' }, { podId: 'c' }]
    assert.equal(selectPeer(candidates, 'first-fit'), 'a')
    assert.equal(selectPeer(candidates, 'first-fit'), 'a')
  })

  it('round-robin cycles through candidates when the SAME state object is reused', () => {
    const candidates = [{ podId: 'a' }, { podId: 'b' }, { podId: 'c' }]
    const state = {}
    assert.equal(selectPeer(candidates, 'round-robin', state), 'a')
    assert.equal(selectPeer(candidates, 'round-robin', state), 'b')
    assert.equal(selectPeer(candidates, 'round-robin', state), 'c')
    assert.equal(selectPeer(candidates, 'round-robin', state), 'a', 'wraps back around')
  })

  it('round-robin with a FRESH state object every call always picks index 0 (documented behavior)', () => {
    const candidates = [{ podId: 'a' }, { podId: 'b' }, { podId: 'c' }]
    assert.equal(selectPeer(candidates, 'round-robin', {}), 'a')
    assert.equal(selectPeer(candidates, 'round-robin', {}), 'a')
  })

  it('round-robin is the default policy when omitted', () => {
    const candidates = [{ podId: 'a' }, { podId: 'b' }]
    const state = {}
    assert.equal(selectPeer(candidates, undefined, state), 'a')
    assert.equal(selectPeer(candidates, undefined, state), 'b')
  })

  it('load-balanced picks the candidate with the lowest load', () => {
    const candidates = [{ podId: 'a', load: 5 }, { podId: 'b', load: 1 }, { podId: 'c', load: 9 }]
    assert.equal(selectPeer(candidates, 'load-balanced'), 'b')
  })

  it('load-balanced treats a missing load as 0', () => {
    const candidates = [{ podId: 'a', load: 5 }, { podId: 'b' }]
    assert.equal(selectPeer(candidates, 'load-balanced'), 'b')
  })

  it('load-balanced picks the first candidate on a tie', () => {
    const candidates = [{ podId: 'a', load: 3 }, { podId: 'b', load: 3 }]
    assert.equal(selectPeer(candidates, 'load-balanced'), 'a')
  })
})
