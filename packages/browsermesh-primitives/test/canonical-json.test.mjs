import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  canonicalJson,
  parseCanonical,
  domainSigningBytes,
  CanonicalJsonError,
  CANONICAL_MAX_INTEGER,
} from '../src/canonical-json.mjs';
import * as index from '../src/index.mjs';

const vectors = JSON.parse(readFileSync(new URL('./vectors/canonical-json.json', import.meta.url), 'utf8'));

const hex = (bytes) => Buffer.from(bytes).toString('hex');

function codeOf(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof CanonicalJsonError, `expected CanonicalJsonError, got ${err}`);
    return err.code;
  }
  assert.fail('expected a throw');
}

describe('canonical JSON vectors', () => {
  for (const v of vectors.encode) {
    it(`encode: ${v.name}`, () => {
      assert.equal(canonicalJson(v.value), v.canonical);
    });
  }
  for (const v of vectors.accept) {
    it(`accept: ${v.name}`, () => {
      const parsed = parseCanonical(v.text);
      assert.equal(canonicalJson(parsed), v.text);
    });
  }
  for (const v of vectors.reject) {
    it(`reject: ${v.name}`, () => {
      assert.equal(codeOf(() => parseCanonical(v.text)), v.code);
    });
  }
  for (const v of vectors.domainSigningBytes) {
    it(`domainSigningBytes: ${v.name}`, () => {
      const out = domainSigningBytes(v.domain, v.text);
      assert.ok(out instanceof Uint8Array);
      assert.equal(hex(out), v.hex);
    });
  }
});

describe('canonicalJson encoder', () => {
  it('exposes the integer bound', () => {
    assert.equal(CANONICAL_MAX_INTEGER, 2 ** 53 - 1);
  });

  it('is independent of insertion order', () => {
    assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  });

  it('has no whitespace', () => {
    assert.equal(/\s/.test(canonicalJson({ a: [1, 2, { b: 'x' }] })), false);
  });

  it('accepts null-prototype objects', () => {
    const o = Object.create(null);
    o.k = 1;
    assert.equal(canonicalJson(o), '{"k":1}');
  });

  it('keeps __proto__ as an ordinary key', () => {
    const o = JSON.parse('{"__proto__":1}');
    assert.equal(canonicalJson(o), '{"__proto__":1}');
  });

  const rejected = [
    ['float', 1.5, 'number-not-integer'],
    ['NaN', NaN, 'number-not-integer'],
    ['Infinity', Infinity, 'number-not-integer'],
    ['-Infinity', -Infinity, 'number-not-integer'],
    ['-0', -0, 'negative-zero'],
    ['2^53', 2 ** 53, 'integer-out-of-range'],
    ['-(2^53)', -(2 ** 53), 'integer-out-of-range'],
    ['bigint', 1n, 'unsupported-type'],
    ['undefined', undefined, 'unsupported-type'],
    ['function', () => 1, 'unsupported-type'],
    ['symbol', Symbol('x'), 'unsupported-type'],
    ['Date', new Date(0), 'unsupported-type'],
    ['Uint8Array', new Uint8Array([1]), 'unsupported-type'],
    ['Map', new Map(), 'unsupported-type'],
    ['class instance', new (class A { x = 1; })(), 'unsupported-type'],
    ['undefined property', { a: undefined }, 'unsupported-type'],
    ['sparse array', [1, , 3], 'unsupported-type'],
    ['non-ascii key', { é: 1 }, 'key-not-ascii'],
    ['astral key', { '\u{1F600}': 1 }, 'key-not-ascii'],
    ['lone surrogate string', '\ud800', 'lone-surrogate'],
    ['lone surrogate key', { '\udc00': 1 }, 'key-not-ascii'],
    ['symbol key', { [Symbol('s')]: 1 }, 'unsupported-type'],
  ];
  for (const [name, value, code] of rejected) {
    it(`rejects ${name}`, () => {
      assert.equal(codeOf(() => canonicalJson(value)), code);
    });
  }

  it('rejects cycles', () => {
    const a = [];
    a.push(a);
    assert.equal(codeOf(() => canonicalJson(a)), 'depth');
  });
});

describe('parseCanonical', () => {
  it('round-trips a realistic document', () => {
    const doc = { v: 1, id: 'abc', serial: 3, issuers: [{ key: 'k', exp: 1700000000 }], extensions: {} };
    assert.deepEqual(parseCanonical(canonicalJson(doc)), doc);
  });

  it('does not let __proto__ change the prototype', () => {
    const parsed = parseCanonical('{"__proto__":{"x":1}}');
    assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
    assert.equal(parsed.x, undefined);
    assert.equal(Object.keys(parsed).length, 1);
  });

  it('rejects absurdly deep input with a typed error, not a stack overflow', () => {
    assert.equal(codeOf(() => parseCanonical('['.repeat(10000) + ']'.repeat(10000))), 'depth');
  });

  it('rejects non-string input', () => {
    assert.equal(codeOf(() => parseCanonical(new Uint8Array([123, 125]))), 'syntax');
    assert.equal(codeOf(() => parseCanonical(undefined)), 'syntax');
  });

  it('errors are Errors with a stable string code', () => {
    try {
      parseCanonical('1e3');
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.equal(err.name, 'CanonicalJsonError');
      assert.equal(typeof err.code, 'string');
      return;
    }
    assert.fail('expected a throw');
  });
});

describe('domainSigningBytes', () => {
  it('different domains give different bytes for the same text', () => {
    const a = domainSigningBytes('browsermesh/realm/descriptor/v1', '{}');
    const b = domainSigningBytes('browsermesh/realm/credential/v1', '{}');
    assert.notEqual(hex(a), hex(b));
  });

  it('the NUL separator keeps domain and text from sliding into each other', () => {
    assert.notEqual(hex(domainSigningBytes('a', 'b/x')), hex(domainSigningBytes('a/b', 'x')));
  });

  it('rejects bad domains', () => {
    for (const d of ['', 'a\u0000b', 'é', 'a b\n', 5, undefined]) {
      assert.equal(codeOf(() => domainSigningBytes(d, '{}')), 'bad-domain');
    }
  });

  it('rejects non-string or ill-formed text', () => {
    assert.equal(codeOf(() => domainSigningBytes('d', 5)), 'syntax');
    assert.equal(codeOf(() => domainSigningBytes('d', '\ud800')), 'lone-surrogate');
  });
});

describe('index exports', () => {
  it('exports the canonical JSON API', () => {
    assert.equal(index.canonicalJson, canonicalJson);
    assert.equal(index.parseCanonical, parseCanonical);
    assert.equal(index.domainSigningBytes, domainSigningBytes);
    assert.equal(index.CanonicalJsonError, CanonicalJsonError);
  });
});
