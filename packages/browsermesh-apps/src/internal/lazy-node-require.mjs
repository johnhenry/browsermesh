/**
 * A Node-only, browser-safe way to obtain a CommonJS-style `require()`
 * bound to a given module URL -- WITHOUT ever writing
 * `import { createRequire } from 'node:module'` at a file's top level.
 *
 * Why this exists: several files in this package resolve an optional
 * peerDependency lazily via `require()` rather than a dynamic `import()`,
 * because the call site is synchronous (a constructor, or a factory whose
 * validation throw is directly tested with `assert.throws()`) and a
 * dynamic `import()` is inherently async. `createRequire()` itself is
 * fine to call lazily, inside the function that needs it -- the bug this
 * file fixes is that a *static* `import ... from 'node:module'` at a
 * file's top level is unconditionally resolved when that file is loaded,
 * before any function runs. In a browser (no bundler, or a bundler that
 * doesn't polyfill Node builtins) that static import fails immediately,
 * which broke importing this package's root entry at all -- even for
 * callers who never touch the optional-peer code path.
 *
 * `process.getBuiltinModule('module')` (Node >=22.3) returns the same
 * `node:module` export without any `import`/`require` of its own, so
 * referencing it only from inside a function -- guarded by
 * `typeof process !== 'undefined'` -- means nothing Node-only executes,
 * and no unresolvable specifier is ever touched, just from importing a
 * file that uses this helper.
 *
 * @param {string} url - Pass `import.meta.url` from the calling module.
 * @returns {NodeRequire} A `require()` bound to `url`.
 * @throws {Error} If called outside Node.js (e.g. in a browser), but only
 *   when a caller actually invokes this -- never merely from importing a
 *   module that references it.
 */
export function createLazyRequire(url) {
  const getBuiltinModule = typeof process !== 'undefined' && process.getBuiltinModule
  if (!getBuiltinModule) {
    throw new Error(
      'createLazyRequire() requires Node.js (process.getBuiltinModule is unavailable) -- ' +
      'this code path is not supported in a browser environment.',
    )
  }
  const { createRequire } = getBuiltinModule('module')
  return createRequire(url)
}
