/**
 * serverless-executor-andbox.mjs -- Phase 3 of the BrowserMesh Serverless
 * plan (`/Users/johnhenry/.claude/plans/at-some-point-within-joyful-dove.md`):
 * the light/default function-execution backend, built on `@johnhenry/andbox`'s
 * Worker-isolated JS runtime.
 *
 * ---------------------------------------------------------------------------
 * ANDBOX IS NOT AN ADVERSARIAL-CODE SANDBOX -- restated here because it is
 * the single most important fact about this file (andbox's own README
 * "Security model" section, and this repo's own research confirms every
 * item below is still live in the version this file depends on):
 *
 *   - Worker-global `fetch`/`WebSocket`/`Worker`/`importScripts` are
 *     reachable by sandboxed code DIRECTLY, regardless of what
 *     `opts.capabilities` are granted -- omitting a `fetch` capability
 *     does not block network access.
 *   - `sandboxImport()` loads any bare `http(s)://` URL unchecked, with no
 *     allowlist, independent of any capability/network policy.
 *   - A capability call still in flight when a timeout fires still
 *     completes its host-side side effect even though the caller is told
 *     the invocation failed -- capabilities passed via `opts.capabilities`
 *     must be idempotent and/or cancellable, this file does no plumbing to
 *     help with that.
 *
 * This tier is appropriate for functions written by a site's own operator
 * or trusted collaborators -- NEVER for running arbitrary third-party or
 * user-submitted code. `serverless-executor-wasmsandbox.mjs` (Phase 6) adds
 * a CPU/memory/instance BUDGET on top of this same trust boundary, not a
 * stronger one -- see that file's own module doc comment when it exists.
 *
 * ---------------------------------------------------------------------------
 * MANDATORY: ONE FRESH SANDBOX PER INVOCATION, NEVER POOLED OR REUSED
 * ACROSS CONCURRENT CALLS.
 *
 * Confirmed by reading andbox's `sandbox.mjs`/`worker-source.mjs` directly:
 * concurrent `evaluate()` calls on ONE sandbox instance share a single
 * Worker realm (no per-call state isolation -- a global mutated by one
 * call leaks into another), and a timeout on one call hard-kills
 * (`worker.terminate()`) the shared worker out from under every OTHER
 * concurrently in-flight call on that instance, which then gets
 * misreported as *its own* timeout, not the real cause. Traced end-to-end
 * through `mesh-service.mjs`'s dispatch loop: inbound `mesh-rpc` requests
 * are handled concurrently, not serialized (`ctx.onIncomingData()`'s
 * callback is fire-and-forget, never awaited before the next message is
 * processed) -- so a shared/pooled sandbox instance would be a real,
 * reachable failure mode, not a hypothetical one. `createAndboxExecutor()`
 * therefore creates a brand-new `createSandbox()` instance inside every
 * call to the returned `executor(job)`, disposed in a `finally`, and
 * NEVER stores one across calls.
 *
 * ---------------------------------------------------------------------------
 * TEST COVERAGE GAP, STATED PLAINLY (do not silently assume this is
 * covered): andbox's own `mode: 'worker'` requires the browser `Worker`
 * global (`new Worker(...)` + `Blob`/`URL.createObjectURL`), which does not
 * exist in plain Node (`node:worker_threads`' `Worker` is a different,
 * incompatible API) -- confirmed directly in this repo's own Node 24 test
 * environment. This file's own test suite can therefore only exercise the
 * REQUEST-SHAPING logic (job construction, preamble injection, dispose-on-
 * error bookkeeping) using `mode: 'inline'`/mocks, not real Worker
 * isolation or the real hard-kill-on-timeout/collateral-damage behavior
 * described above. andbox's own upstream test suite has this exact same
 * gap (its only timeout example runs under Node, exercising the weaker
 * inline-mode Promise-race timeout, never a real Worker hard-kill). A real
 * concurrency regression test (two overlapping requests, one deliberately
 * runaway, assert the other's result is unaffected) needs an actual
 * browser test environment and is intentionally NOT claimed as covered
 * here.
 *
 * ---------------------------------------------------------------------------
 * REQUEST DATA IS INJECTED VIA A JSON PREAMBLE, NOT A CAPABILITY.
 *
 * `actually-serverless`'s own `createFunctionHandler.mjs` takes a `preamble`
 * string prepended to the function source before evaluation -- the same
 * pattern used here: `job.request` (the inbound `{fromPubKey, method, path,
 * headers, body}`) is JSON-serialized into a `const request = ...;`
 * preamble prepended to `job.code` before `sandbox.evaluate()`, so function
 * code can reference a `request` variable directly. This is plain,
 * already-known data, not a live host capability -- no RPC round-trip
 * needed for it, unlike genuine host capabilities (KV access, peer calls)
 * a caller passes via `opts.capabilities`.
 *
 * ---------------------------------------------------------------------------
 * `@johnhenry/andbox` IS IMPORTED LAZILY (inside the returned executor, not
 * at module top level), unlike this package's other optional peer
 * dependencies. Every other optional peer here (`browsermesh-core`,
 * `browsermesh-discovery`, ...) is a SIBLING package in this same npm
 * workspace, so it's always physically present in `node_modules` during
 * this monorepo's own `npm install`/CI regardless of the "optional" marking
 * -- that marking only matters for a standalone external consumer.
 * `@johnhenry/andbox` is a genuinely separate repo/package, not a workspace
 * sibling, and (as of this writing) isn't published to npm yet -- a static
 * top-level import here would make `index.mjs`'s eager `export *` chain
 * fail for the ENTIRE package the moment `@johnhenry/andbox` is absent,
 * breaking every consumer/test, not just ones using this specific executor.
 * A dynamic `import()` inside the executor defers that requirement to
 * "only if this specific executor is actually invoked."
 *
 * @module serverless-executor-andbox
 */

/**
 * @typedef {object} AndboxJob
 * @property {string} code - function source, evaluated as the body of an async IIFE (andbox's own `evaluate()` semantics -- top-level `return`/`await` both work).
 * @property {object} [request] - the inbound request, JSON-injected as a `request` const in scope for `code`. See module doc comment.
 * @property {number} [timeoutMs] - per-invocation override of `opts.defaultTimeoutMs`.
 */

/**
 * @param {object} [opts]
 * @param {Record<string, Function>} [opts.capabilities] - forwarded to andbox `createSandbox()` as-is. See module doc comment's security-model section before granting anything here.
 * @param {object} [opts.importMap] - forwarded to andbox `createSandbox()` as-is.
 * @param {number} [opts.defaultTimeoutMs] - forwarded to andbox `createSandbox()` as its `defaultTimeoutMs`; per-job `timeoutMs` overrides this for that one `evaluate()` call.
 * @returns {(job: AndboxJob) => Promise<*>} the executor -- one fresh sandbox per call, always disposed. Rejects if the sandboxed code throws, times out (andbox's own `TimeoutError`), or is aborted.
 */
export function createAndboxExecutor({ capabilities, importMap, defaultTimeoutMs } = {}) {
  return async function executeAndbox(job) {
    if (!job || typeof job.code !== 'string') {
      throw new Error('createAndboxExecutor: job.code is required and must be a string')
    }

    const preamble = job.request !== undefined ? `const request = ${JSON.stringify(job.request)};\n` : ''

    // Lazy import -- see module doc comment for why this isn't a top-level
    // static import.
    const { createSandbox } = await import('@johnhenry/andbox')

    // See module doc comment: MANDATORY fresh sandbox per invocation, never
    // shared across concurrent calls.
    const sandbox = await createSandbox({ mode: 'worker', capabilities, importMap, defaultTimeoutMs })
    try {
      return await sandbox.evaluate(preamble + job.code, job.timeoutMs !== undefined ? { timeout: job.timeoutMs } : undefined)
    } finally {
      await sandbox.dispose()
    }
  }
}
