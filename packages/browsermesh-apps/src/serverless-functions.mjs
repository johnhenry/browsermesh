/**
 * serverless-functions.mjs -- Phase 3 of the BrowserMesh Serverless plan
 * (`/Users/johnhenry/.claude/plans/at-some-point-within-joyful-dove.md`):
 * the backend-agnostic route matcher that adapts a pluggable `executor`
 * (`serverless-executor-andbox.mjs`'s light tier, or Phase 6's
 * `serverless-executor-wasmsandbox.mjs` heavier tier) into
 * `serverless-router.mjs`'s `functionsHandler` slot.
 *
 * Kept deliberately separate from any specific executor: swapping which
 * backend a site uses (`'andbox'` vs `'wasmsandbox'`, per the plan's design
 * decision) is a config choice on `createFunctionsHandler({executor})`, not
 * a change to route matching or request/response shaping.
 *
 * @module serverless-functions
 */

/**
 * @typedef {object} FunctionRoute
 * @property {string} path - exact path to match (e.g. `'/api/hello'`). No pattern/param matching in v1 -- exact string match only, mirroring `createStaticHandler()`'s own "built fresh, no premature generality" scope.
 * @property {string} [method='GET']
 * @property {string} code - function source handed to the executor's `job.code`.
 */

/**
 * If the sandboxed code's return value is already response-shaped (a plain
 * object with a numeric `status`), use it as-is (with `body`/`headers`
 * defaults). Otherwise, wrap the raw value as a JSON body with a 200.
 *
 * @param {*} result
 * @returns {{status: number, headers: object, body: *}}
 */
function normalizeFunctionResult(result) {
  if (result && typeof result === 'object' && typeof result.status === 'number') {
    return { status: result.status, headers: result.headers || {}, body: result.body }
  }
  return { status: 200, headers: { 'content-type': 'application/json' }, body: result }
}

/**
 * @param {object} opts
 * @param {FunctionRoute[]} [opts.routes]
 * @param {(job: {code: string, request?: object, timeoutMs?: number}) => Promise<*>} opts.executor
 *   Typically `createAndboxExecutor(...)` (Phase 3) or, later,
 *   `createWasmSandboxExecutor(...)` (Phase 6) -- both share this same
 *   `executor(job) -> Promise<result>` shape, so the backend is swappable
 *   without touching this file.
 * @param {number} [opts.timeoutMs] - passed through as each job's `timeoutMs`.
 * @returns {(req: {fromPubKey?: string, method?: string, path?: string, headers?: object, body?: *}) => Promise<{status: number, headers: object, body: *}|null>}
 *   `null` for a request matching no route -- "not mine, try the next handler in the chain" (the proxy handler, or a 404).
 */
export function createFunctionsHandler({ routes = [], executor, timeoutMs } = {}) {
  if (typeof executor !== 'function') {
    throw new Error('createFunctionsHandler: opts.executor is required and must be a function')
  }

  return async function handleFunctions({ fromPubKey, method = 'GET', path = '/', headers = {}, body } = {}) {
    const route = routes.find((r) => r.path === path && (r.method || 'GET') === method)
    if (!route) return null

    try {
      const result = await executor({ code: route.code, request: { fromPubKey, method, path, headers, body }, timeoutMs })
      return normalizeFunctionResult(result)
    } catch (err) {
      return { status: 500, headers: { 'content-type': 'application/json' }, body: { error: err?.message || String(err) } }
    }
  }
}
