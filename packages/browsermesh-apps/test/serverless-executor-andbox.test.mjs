/**
 * Tests for serverless-executor-andbox.mjs (Phase 3 of the BrowserMesh
 * Serverless plan -- see that file's own module doc comment).
 *
 * COVERAGE GAP, STATED HONESTLY (matches the source file's own "TEST
 * COVERAGE GAP" section -- do not remove this note without addressing the
 * underlying gap): `createAndboxExecutor()` hardcodes andbox's `mode:
 * 'worker'`, which requires the browser `Worker` global. Plain Node has no
 * such global (`typeof Worker === 'undefined'`, confirmed directly in this
 * repo's own Node 24 test environment -- `node:worker_threads`' `Worker` is
 * a different, incompatible API andbox does not use). This means the real
 * sandboxed-evaluation path (a real Worker actually running `job.code`,
 * real isolation, real timeout/hard-kill/dispose behavior) CANNOT be
 * exercised by this Node-based test suite at all -- calling the returned
 * executor with valid input would throw `ReferenceError: Worker is not
 * defined` immediately inside andbox's own `createSandbox()`, not a
 * failure of this file's own code.
 *
 * This file therefore only tests what genuinely doesn't require a real
 * Worker: input validation, which happens before `createSandbox()` is ever
 * called, plus (now that `@johnhenry/andbox` is published) that the lazy
 * `import()` itself actually resolves against the real package and exposes
 * the shape this file depends on. A real end-to-end proof (including the
 * mandatory fresh-sandbox-per-invocation concurrency invariant this file's
 * module doc comment documents) still needs an actual browser test
 * environment and is intentionally not claimed as covered here.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/serverless-executor-andbox.test.mjs
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createAndboxExecutor } from '../src/serverless-executor-andbox.mjs'

describe('createAndboxExecutor: input validation (does not require a real Worker)', () => {
  it('rejects a job with no code', async () => {
    const executor = createAndboxExecutor()
    await assert.rejects(() => executor({}), /job\.code is required/)
  })

  it('rejects a job whose code is not a string', async () => {
    const executor = createAndboxExecutor()
    await assert.rejects(() => executor({ code: 42 }), /job\.code is required/)
  })

  it('rejects a null/undefined job the same way', async () => {
    const executor = createAndboxExecutor()
    await assert.rejects(() => executor(null), /job\.code is required/)
    await assert.rejects(() => executor(undefined), /job\.code is required/)
  })
})

describe('createAndboxExecutor: real package resolution (no Worker needed)', () => {
  it('the lazy import() resolves @johnhenry/andbox and exposes createSandbox', async () => {
    const mod = await import('@johnhenry/andbox')
    assert.equal(typeof mod.createSandbox, 'function')
  })
})
