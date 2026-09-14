/**
 * Tests for serverless-wire.mjs (Phase 2 of the BrowserMesh Serverless
 * plan -- see that file's own module doc comment).
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/serverless-wire.test.mjs
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { encodeWireResponse, decodeWireResponse, WIRE_ENCODING_HEADER } from '../src/serverless-wire.mjs'

const enc = new TextEncoder()
const dec = new TextDecoder()

describe('encodeWireResponse/decodeWireResponse', () => {
  it('round-trips a Uint8Array body through base64 encoding, preserving exact bytes', () => {
    const bytes = enc.encode('hello binary world')
    const wire = encodeWireResponse({ status: 200, headers: { 'content-type': 'text/plain' }, body: bytes })

    assert.equal(typeof wire.body, 'string', 'wire body must be JSON-safe (a string), not a raw Uint8Array')
    assert.equal(wire.headers[WIRE_ENCODING_HEADER], 'base64')
    assert.equal(wire.headers['content-type'], 'text/plain', 'original headers must survive alongside the encoding marker')

    const decoded = decodeWireResponse(wire)
    assert.ok(decoded.body instanceof Uint8Array)
    assert.equal(dec.decode(decoded.body), 'hello binary world')
    assert.equal(decoded.headers[WIRE_ENCODING_HEADER], undefined, 'the internal marker must never leak into the decoded headers')
    assert.equal(decoded.headers['content-type'], 'text/plain')
  })

  it('round-trips an ArrayBuffer body identically to a Uint8Array', () => {
    const bytes = enc.encode('array buffer body')
    const wire = encodeWireResponse({ body: bytes.buffer })
    const decoded = decodeWireResponse(wire)
    assert.equal(dec.decode(decoded.body), 'array buffer body')
  })

  it('passes a string body through unchanged, with no encoding marker', () => {
    const wire = encodeWireResponse({ status: 404, headers: { 'content-type': 'application/json' }, body: '{"error":"not found"}' })
    assert.equal(wire.body, '{"error":"not found"}')
    assert.equal(wire.headers[WIRE_ENCODING_HEADER], undefined)

    const decoded = decodeWireResponse(wire)
    assert.equal(decoded.body, '{"error":"not found"}')
  })

  it('passes a plain-object body through unchanged', () => {
    const wire = encodeWireResponse({ body: { error: 'nope' } })
    assert.deepEqual(wire.body, { error: 'nope' })
    const decoded = decodeWireResponse(wire)
    assert.deepEqual(decoded.body, { error: 'nope' })
  })

  it('defaults status to 200 and headers to {} when omitted', () => {
    const wire = encodeWireResponse({ body: 'x' })
    assert.equal(wire.status, 200)
    assert.deepEqual(wire.headers, {})
  })

  it('decodeWireResponse strips the marker even on a non-encoded response (defensive, no-op case)', () => {
    const decoded = decodeWireResponse({ status: 200, headers: { 'content-type': 'text/plain' }, body: 'plain text' })
    assert.equal(decoded.body, 'plain text')
    assert.equal(decoded.headers[WIRE_ENCODING_HEADER], undefined)
  })
})
