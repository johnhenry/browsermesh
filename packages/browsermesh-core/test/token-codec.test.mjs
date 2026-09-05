// Token codec: the two paths in handshake.mjs that handle data arriving from
// outside the process — encoding something large, and decoding something
// hostile.
//
// Kept in its own file rather than appended to handshake.test.mjs because
// these exercise the codec helpers, not the handshake protocol.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  toBase64Url,
  fromBase64Url,
  DirectInputHandshake,
  TokenDecodeError,
  MAX_ENCODED_TOKEN_LENGTH,
} from '../src/handshake.mjs'

describe('toBase64Url — large inputs', () => {
  // The bug: `String.fromCharCode(...bytes)` turns each byte into an argument
  // and V8 caps the argument list, so this threw
  // `RangeError: Maximum call stack size exceeded` somewhere around 124 KB.
  // Measured on main by bisection: largest length that encoded was 124,209,
  // and the exact ceiling moves with the caller's stack depth — so the same
  // input could encode from one call site and throw from another.

  it('encodes 256 KB without throwing', () => {
    const bytes = new Uint8Array(256 * 1024)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff
    const encoded = toBase64Url(bytes)
    assert.equal(typeof encoded, 'string')
    // base64 is 4 characters per 3 bytes, unpadded here.
    assert.equal(encoded.length, Math.ceil(bytes.length / 3) * 4 - 2)
  })

  it('round-trips a 256 KB payload byte for byte', () => {
    const bytes = new Uint8Array(256 * 1024)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff
    assert.deepEqual(fromBase64Url(toBase64Url(bytes)), bytes)
  })

  it('encodes every length straddling the internal chunk boundary', () => {
    // 0x8000 is the chunk size; an off-by-one there would corrupt or drop
    // bytes rather than throw, which is the failure a size-only test misses.
    for (const n of [0x7fff, 0x8000, 0x8001, 0x10000, 0x10001, 0x18000]) {
      const bytes = new Uint8Array(n)
      for (let i = 0; i < n; i++) bytes[i] = (i * 31) & 0xff
      assert.deepEqual(fromBase64Url(toBase64Url(bytes)), bytes, `length ${n}`)
    }
  })

  it('still handles the small and empty cases', () => {
    assert.equal(toBase64Url(new Uint8Array(0)), '')
    assert.deepEqual(fromBase64Url(toBase64Url(new Uint8Array([0, 1, 254, 255]))),
      new Uint8Array([0, 1, 254, 255]))
  })

  it('accepts a plain array of byte values, as the spread form did', () => {
    assert.equal(toBase64Url([104, 105]), toBase64Url(new Uint8Array([104, 105])))
  })

  it('encodeToken survives a token with a very large iceServers list', async () => {
    // Reachable through the public API without doing anything unreasonable:
    // a token carrying a large TURN list. On main this threw RangeError at a
    // token of 266,825 JSON bytes.
    const handshake = new DirectInputHandshake({
      localPodId: 'pod-local',
      getPublicKeyBytes: async () => new Uint8Array(32),
      iceServers: Array.from({ length: 3000 }, (_, i) => ({
        urls: `turn:relay-${i}.example.com:3478`,
        username: `user${i}`,
        credential: `pass${i}`,
      })),
    })
    const token = await handshake.generateToken()
    const json = JSON.stringify(token)
    assert.ok(json.length > 200_000, `token JSON is ${json.length} bytes`)

    const encoded = handshake.encodeToken(token)
    assert.equal(typeof encoded, 'string')
    // Round-trips, given a maxLength that admits it.
    const decoded = DirectInputHandshake.decodeToken(encoded, { maxLength: encoded.length })
    assert.deepEqual(decoded, token)
  })
})

describe('decodeToken — malformed and hostile input', () => {
  // decodeToken is the first thing that touches a scanned QR code or a pasted
  // clipboard string. On main it was atob -> TextDecoder -> JSON.parse with
  // nothing around it, so callers had to catch DOMException and SyntaxError
  // from a method whose signature mentioned neither.

  const cases = [
    ['not valid base64url', 'not-valid-base64url!!!', /not valid base64url/],
    ['an empty string', '', /empty/],
    ['valid base64url that is not JSON', 'aGVsbG8', /not valid JSON/],
    ['JSON that is not an object', 'MTIz', /not an object/],          // 123
    ['JSON null', 'bnVsbA', /not an object/],                          // null
    ['a JSON array', 'W10', /not an object/],                          // []
  ]

  for (const [what, input, message] of cases) {
    it(`throws TokenDecodeError for ${what}`, () => {
      assert.throws(
        () => DirectInputHandshake.decodeToken(input),
        (err) => {
          assert.ok(err instanceof TokenDecodeError, `expected TokenDecodeError, got ${err?.constructor?.name}`)
          assert.equal(err.name, 'TokenDecodeError')
          assert.match(err.message, message)
          // Never a bare platform exception escaping the contract.
          assert.ok(!(err instanceof SyntaxError))
          assert.ok(typeof DOMException === 'undefined' || !(err instanceof DOMException))
          return true
        },
      )
    })
  }

  it('throws TokenDecodeError for non-string input', () => {
    for (const bad of [null, undefined, 42, {}, new Uint8Array(4)]) {
      assert.throws(() => DirectInputHandshake.decodeToken(bad), TokenDecodeError)
    }
  })

  it('keeps the originating platform error as `cause`', () => {
    try {
      DirectInputHandshake.decodeToken('not-valid-base64url!!!')
      assert.fail('should have thrown')
    } catch (err) {
      assert.ok(err instanceof TokenDecodeError)
      assert.ok(err.cause, 'the platform error is preserved for debugging')
    }
  })

  it('refuses oversized input before decoding it', () => {
    const huge = 'A'.repeat(MAX_ENCODED_TOKEN_LENGTH + 1)
    assert.throws(
      () => DirectInputHandshake.decodeToken(huge),
      (err) => {
        assert.ok(err instanceof TokenDecodeError)
        assert.match(err.message, /too long/)
        return true
      },
    )
  })

  it('honours an explicit maxLength', () => {
    const handshake = new DirectInputHandshake({
      localPodId: 'pod-local',
      getPublicKeyBytes: async () => new Uint8Array(32),
    })
    return handshake.generateToken().then((token) => {
      const encoded = handshake.encodeToken(token)
      assert.throws(
        () => DirectInputHandshake.decodeToken(encoded, { maxLength: encoded.length - 1 }),
        /too long/,
      )
      assert.deepEqual(
        DirectInputHandshake.decodeToken(encoded, { maxLength: encoded.length }),
        token,
      )
    })
  })

  it('the default limit is far above anything a QR code can carry', () => {
    // The densest QR code holds 2,953 bytes of binary data.
    assert.ok(MAX_ENCODED_TOKEN_LENGTH > 2953 * 10)
  })

  it('still round-trips an ordinary token', async () => {
    const handshake = new DirectInputHandshake({
      localPodId: 'pod-local',
      getPublicKeyBytes: async () => new Uint8Array(32),
      signalingUrl: 'wss://example.invalid/signal',
    })
    const token = await handshake.generateToken()
    assert.deepEqual(DirectInputHandshake.decodeToken(handshake.encodeToken(token)), token)
  })
})
