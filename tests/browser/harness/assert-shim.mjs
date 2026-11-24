/**
 * `node:assert/strict` for the page, so the repository's examples run in a
 * browser unmodified. Only what the examples use; failures throw.
 */

export class AssertionError extends Error {
  constructor(message) { super(message); this.name = 'AssertionError' }
}

const fail = (message, fallback) => { throw message instanceof Error ? message : new AssertionError(message ?? fallback) }
const show = (v) => { try { return typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v) } catch { return String(v) } }

function deepEq(a, b) {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false
  if (a instanceof Map || a instanceof Set) {
    if (a.size !== b.size) return false
    return deepEq([...a], [...b])
  }
  if (ArrayBuffer.isView(a)) {
    return a.length === b.length && a.every((x, i) => Object.is(x, b[i]))
  }
  const ka = Reflect.ownKeys(a)
  const kb = Reflect.ownKeys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => Object.hasOwn(b, k) && deepEq(a[k], b[k]))
}

const assert = (value, message) => assert.ok(value, message)
assert.ok = (value, message) => { if (!value) fail(message, `expected truthy, got ${show(value)}`) }
assert.equal = (a, b, message) => { if (!Object.is(a, b)) fail(message, `${show(a)} !== ${show(b)}`) }
assert.strictEqual = assert.equal
assert.notEqual = (a, b, message) => { if (Object.is(a, b)) fail(message, `expected values to differ: ${show(a)}`) }
assert.notStrictEqual = assert.notEqual
assert.deepEqual = (a, b, message) => { if (!deepEq(a, b)) fail(message, `${show(a)} not deep-equal to ${show(b)}`) }
assert.deepStrictEqual = assert.deepEqual
assert.notDeepEqual = (a, b, message) => { if (deepEq(a, b)) fail(message, 'expected values to differ') }
assert.match = (s, re, message) => { if (!re.test(s)) fail(message, `${show(s)} does not match ${re}`) }
assert.throws = (fn, expected, message) => {
  try { fn() } catch (err) {
    if (typeof expected === 'function' && expected.prototype !== undefined && !(err instanceof expected)) throw err
    if (expected instanceof RegExp && !expected.test(String(err?.message ?? err))) throw err
    return
  }
  fail(message, 'expected the function to throw')
}
assert.rejects = async (promiseOrFn, expected, message) => {
  try { await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn) } catch (err) {
    if (typeof expected === 'function' && expected.prototype !== undefined && !(err instanceof expected)) throw err
    if (expected instanceof RegExp && !expected.test(String(err?.message ?? err))) throw err
    return
  }
  fail(message, 'expected the promise to reject')
}
assert.fail = (message) => fail(message, 'assert.fail()')
assert.AssertionError = AssertionError
assert.strict = assert

export default assert
export const { ok, equal, strictEqual, notEqual, notStrictEqual, deepEqual, deepStrictEqual, notDeepEqual, match, throws, rejects } = assert
