/**
 * Regression coverage for issue #183: importing the package root (or any
 * of its re-exported modules) must not execute Node-only code merely by
 * being loaded -- specifically, no file reachable from `src/index.mjs`
 * may statically `import ... from 'node:module'` at module top level.
 *
 * Before the fix, seven files (mesh-fetch.mjs, mesh-websocket.mjs,
 * serverless-fetch.mjs, cloud-storage-backend.mjs, mesh-swarm.mjs,
 * mesh-dht.mjs, mesh-relay-backend.mjs) each had a top-level
 * `import { createRequire } from 'node:module'`, which fails immediately
 * when resolved in a browser bundle -- even for callers who never touch
 * the optional-peer code path those files exist for. All seven are
 * re-exported from the package root via `export * from './<file>.mjs'`,
 * so `import '@johnhenry/browsermesh-apps'` failed outright in a browser.
 *
 * This file has two layers of coverage:
 *   1. A static check that walks the real `export * from`/`export { .. }
 *      from`/`import .. from` graph starting at `src/index.mjs` and
 *      asserts no reachable file's source contains the string
 *      `node:module` outside of a comment. A same-file negative control
 *      (`hasBrowserUnsafeNodeModuleImport`) proves the checker actually
 *      catches the bug pattern it exists to catch.
 *   2. A real dynamic `import()` of the package root and of each
 *      known-affected subpath/module, run in this same Node process, to
 *      confirm the fix didn't break anything and the barrel still loads
 *      and exposes the expected exports.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/browser-safe-entry.test.mjs
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')
const ENTRY = path.join(SRC_DIR, 'index.mjs')

/**
 * Files previously known to have a top-level `createRequire(import.meta.url)`
 * behind a static `import ... from 'node:module'`. Kept explicit (rather
 * than only relying on graph traversal) so this test still means something
 * even if a future refactor changes how index.mjs re-exports things.
 */
const PREVIOUSLY_AFFECTED_FILES = [
  'mesh-fetch.mjs',
  'mesh-websocket.mjs',
  'serverless-fetch.mjs',
  'cloud-storage-backend.mjs',
  'mesh-swarm.mjs',
  'mesh-dht.mjs',
  'mesh-relay-backend.mjs',
]

/**
 * Returns true if `source` contains a real, top-level (non-comment)
 * static import of `node:module` -- the exact pattern that breaks a
 * browser bundle merely by being loaded. Deliberately simple/line-based
 * (this codebase has no build step and no bundler dependency to lean on
 * for a real AST parse), but strict enough to catch the actual bug: it
 * only matches a line that is an `import` statement naming the
 * `node:module` specifier, and ignores lines that are `//` comments or
 * inside a `/* ... *\/` block comment.
 * @param {string} source
 * @returns {boolean}
 */
function hasBrowserUnsafeNodeModuleImport(source) {
  let inBlockComment = false
  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim()
    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false
      continue
    }
    if (line.startsWith('/**') || line.startsWith('/*')) {
      if (!line.includes('*/')) inBlockComment = true
      continue
    }
    if (line.startsWith('//') || line.startsWith('*')) continue
    if (/^import\b.*from\s+['"]node:module['"]/.test(line)) return true
  }
  return false
}

/**
 * Walks the relative `export * from '...'` / `export { .. } from '...'` /
 * `import .. from '...'` graph starting at `entryFile`, following only
 * relative specifiers (bare specifiers like `@johnhenry/...` or
 * `node:...` are dependency boundaries, not part of this package's own
 * reachable source). Returns a Map<absolutePath, source>.
 * @param {string} entryFile
 * @returns {Map<string, string>}
 */
function collectReachableFiles(entryFile) {
  const seen = new Map()
  const stack = [entryFile]
  const specifierRe = /from\s+['"](\.[^'"]+)['"]/g

  while (stack.length) {
    const file = stack.pop()
    if (seen.has(file)) continue
    const source = readFileSync(file, 'utf8')
    seen.set(file, source)

    for (const match of source.matchAll(specifierRe)) {
      const specifier = match[1]
      const resolved = path.resolve(path.dirname(file), specifier)
      if (!seen.has(resolved)) stack.push(resolved)
    }
  }
  return seen
}

describe('browser-safe package root (issue #183)', () => {
  it('negative control: the checker itself catches the exact bug pattern it exists to catch', () => {
    const buggy = [
      "/**",
      " * Some doc comment mentioning node:module in prose, which must NOT trip this up.",
      " */",
      "import { createRequire } from 'node:module'",
      "",
      "const require = createRequire(import.meta.url)",
    ].join('\n')
    assert.equal(
      hasBrowserUnsafeNodeModuleImport(buggy),
      true,
      'checker failed to flag a real top-level import of node:module',
    )
  })

  it('negative control: a file that only mentions node:module in comments is not flagged', () => {
    const safe = [
      "/**",
      " * This file explains, in prose, why it avoids `import ... from 'node:module'`.",
      " */",
      "import { createLazyRequire } from './internal/lazy-node-require.mjs'",
    ].join('\n')
    assert.equal(
      hasBrowserUnsafeNodeModuleImport(safe),
      false,
      'checker false-positived on a comment-only mention of node:module',
    )
  })

  it('no file reachable from src/index.mjs statically imports node:module at top level', () => {
    const reachable = collectReachableFiles(ENTRY)
    assert.ok(reachable.size > 50, `expected a large reachable graph from index.mjs, got ${reachable.size} files`)

    const offenders = []
    for (const [file, source] of reachable) {
      if (hasBrowserUnsafeNodeModuleImport(source)) offenders.push(file)
    }
    assert.deepEqual(
      offenders,
      [],
      `these files reachable from index.mjs statically import node:module, which breaks a browser import of the package root: ${offenders.join(', ')}`,
    )
  })

  it('each previously-affected file is actually part of the reachable graph (sanity: the test above is not vacuous)', () => {
    const reachable = collectReachableFiles(ENTRY)
    const reachableBasenames = new Set([...reachable.keys()].map((f) => path.basename(f)))
    for (const name of PREVIOUSLY_AFFECTED_FILES) {
      assert.ok(reachableBasenames.has(name), `${name} is no longer reachable from index.mjs -- update this test if that's intentional`)
    }
  })

  it('each previously-affected file uses the lazy, browser-safe require helper instead', () => {
    for (const name of PREVIOUSLY_AFFECTED_FILES) {
      const source = readFileSync(path.join(SRC_DIR, name), 'utf8')
      assert.match(
        source,
        /createLazyRequire\(import\.meta\.url\)/,
        `${name} should resolve its optional peer via createLazyRequire(import.meta.url), not a top-level createRequire`,
      )
    }
  })

  it('importing the package root in a real (non-browser) environment still works and exposes expected exports', async () => {
    const mod = await import('../src/index.mjs')
    // Spot-check a handful of exports spanning several of the previously-affected files.
    assert.equal(typeof mod.createBrowserMeshFetch, 'function')
    assert.equal(typeof mod.BrowserMeshWebSocket, 'function')
    assert.equal(typeof mod.createServerlessFetchRouter, 'function')
    assert.equal(typeof mod.createCloudStorageBackend, 'function')
    assert.equal(typeof mod.createMeshDht, 'function')
    assert.equal(typeof mod.createMeshRelayBackend, 'function')
  })

  it('createLazyRequire() fails clearly (not with a browser-breaking import) when Node builtin access is unavailable', async () => {
    const { createLazyRequire } = await import('../src/internal/lazy-node-require.mjs')
    const realGetBuiltinModule = process.getBuiltinModule
    // Simulate the one thing that actually differs in a browser: no
    // process.getBuiltinModule. Importing this module already succeeded
    // above (that's the fix) -- this proves that *calling* the lazy
    // helper without Node builtin access fails with a clear, catchable
    // Error rather than the browser's own unrelated module-resolution
    // failure.
    // @ts-ignore -- deliberately deleting a Node builtin for this assertion
    delete process.getBuiltinModule
    try {
      assert.throws(
        () => createLazyRequire(import.meta.url),
        /requires Node\.js/,
      )
    } finally {
      process.getBuiltinModule = realGetBuiltinModule
    }
  })
})
