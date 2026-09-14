/**
 * agent-runtime.mjs -- Phase 2 of the agent tool-calling runtime plan (issue
 * #90): the tool-dispatch conversation loop that sits on top of Phase 1's
 * `BrowserToolRegistry` (`compat.mjs`, PR #141).
 *
 * This is NOT a `MeshService` -- it never touches `PeerNode`, `attach()`, or
 * `ctx`. It is a standalone composition-root utility, the same category as
 * `cloud-storage.mjs`'s `CloudStorage` class: a caller constructs it directly
 * (typically once per conversation/session) and drives it with `.run()`. No
 * mesh wiring happens here at all -- if a tool's `.execute()` needs to reach
 * a peer, that's the tool's own business (see e.g. `orchestrator.mjs`'s
 * `Meshctl*Tool`s, wired to a real `MeshOrchestrator` in Phase 3/4).
 *
 * ---------------------------------------------------------------------------
 * REQUIRED DEPENDENCIES -- `registry` AND `llmFn`, BOTH CHECKED HERE DIRECTLY
 *
 * Matches the "bring-your-own executor, required, no default shipped"
 * pattern `mesh-compute.mjs`'s `executeFn` and `mesh-agent-swarm.mjs`'s
 * `agentProxy` already established (issue #86's resolved design pass) --
 * `createAgentSwarmService()` throws immediately, before constructing
 * anything, if `agentProxy` is missing; this file does the same for both of
 * its own required collaborators:
 *
 *   - `registry` -- a `BrowserToolRegistry` instance (`compat.mjs`, Phase 1).
 *     Duck-typed (`.listSpecs`/`.get` both functions) rather than
 *     `instanceof`-checked, for the same cross-package "standalone use"
 *     reason `BrowserToolRegistry.register()` itself duck-types its
 *     argument -- this package vendors its own copy of `BrowserTool`/
 *     `BrowserToolRegistry` (see `compat.mjs`'s header), so a registry built
 *     against `browsermesh-core`'s copy is not `instanceof`
 *     `browsermesh-apps`'s class even though it has the identical shape.
 *   - `llmFn` -- REQUIRED, no default implementation is provided by this
 *     file or this package. browsermesh never takes a dependency on a
 *     specific LLM vendor's SDK (see the agent-runtime plan's "Context"
 *     section) -- the runtime provides the real tool-registry/dispatch loop;
 *     the caller supplies the actual "ask an LLM what to do next" step.
 *
 * ---------------------------------------------------------------------------
 * THE `llmFn` SHAPE -- `async llmFn(messages, toolSpecs) -> { content?, toolCalls? }`
 *
 *   - `messages` -- the full running conversation so far, an array of
 *     `{ role, ... }` entries (see "MESSAGE SHAPES" below for the exact
 *     entries this file appends).
 *   - `toolSpecs` -- `registry.listSpecs()`, i.e. every registered tool's
 *     `.spec` (`{ name, description, parameters, required_permission }`,
 *     see `compat.mjs`'s `BrowserTool.spec` getter) -- this is what `llmFn`
 *     hands to whatever real LLM API it wraps as that API's tool/function
 *     definitions.
 *   - Return value: `{ content?: string, toolCalls?: [{ id, name, arguments }] }`.
 *     - `toolCalls` present and non-empty -- the LLM wants to invoke one or
 *       more tools before answering; `run()` dispatches each one (see
 *       "DISPATCH" below) and calls `llmFn` again with the results appended.
 *     - `toolCalls` absent/empty and `content` present -- treated as the
 *       final answer; `run()` returns it and stops.
 *     - `llmFn` may legitimately need several `await`s of its own (an HTTP
 *       call, retries, etc.) -- that is entirely its own business; this
 *       loop just awaits whatever it returns.
 *
 * WORKED EXAMPLE -- wrapping a real LLM API's tool-calling response format.
 * No real network call is made here; this shows only the shape translation
 * an `llmFn` implementation is responsible for, both directions:
 *
 * ```js
 * import { createAgentRuntime } from '@johnhenry/browsermesh-apps';
 *
 * // Suppose `realClient.chat(...)` is a real LLM SDK's chat-completion call
 * // and it returns messages shaped like:
 * //   { role: 'assistant',
 * //     content: [
 * //       { type: 'text', text: 'Let me check that for you.' },
 * //       { type: 'tool_use', id: 'call_1', name: 'dht_lookup', input: { key: 'foo' } },
 * //     ] }
 * // (a content-block style, e.g. Anthropic's Messages API shape) -- OR,
 * // for a flatter OpenAI-style API:
 * //   { role: 'assistant', content: null,
 * //     tool_calls: [{ id: 'call_1', function: { name: 'dht_lookup', arguments: '{"key":"foo"}' } }] }
 *
 * async function llmFn(messages, toolSpecs) {
 *   // 1. Translate `toolSpecs` ({name, description, parameters,
 *   //    required_permission}) into the vendor's own tool-definition shape.
 *   //    Most vendor APIs want {name, description, input_schema/parameters}
 *   //    -- `required_permission` is browsermesh-specific and has no vendor
 *   //    equivalent, so it's simply dropped here (or kept out-of-band for
 *   //    the caller's own policy layer -- see `checkAccess()` precedent in
 *   //    mesh-compute.mjs/mesh-agent-swarm.mjs for where that belongs).
 *   const vendorTools = toolSpecs.map(({ name, description, parameters }) => (
 *     { name, description, input_schema: parameters }
 *   ));
 *
 *   // 2. Translate `messages` (see "MESSAGE SHAPES" below) into the
 *   //    vendor's own conversation format. Exactly how depends on the
 *   //    vendor; sketched here rather than fully implemented.
 *   const vendorMessages = messages.map(toVendorMessage);
 *
 *   // const response = await realClient.chat({ messages: vendorMessages, tools: vendorTools });
 *   const response = { role: 'assistant', content: [
 *     { type: 'text', text: 'Let me check that for you.' },
 *     { type: 'tool_use', id: 'call_1', name: 'dht_lookup', input: { key: 'foo' } },
 *   ] }; // stand-in for the real API call
 *
 *   // 3. Translate the vendor's response back into this file's
 *   //    {content?, toolCalls?} shape.
 *   const textBlocks = response.content.filter((b) => b.type === 'text');
 *   const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
 *   return {
 *     content: textBlocks.length ? textBlocks.map((b) => b.text).join('') : undefined,
 *     toolCalls: toolUseBlocks.length
 *       ? toolUseBlocks.map((b) => ({ id: b.id, name: b.name, arguments: b.input }))
 *       : undefined,
 *   };
 * }
 *
 * const runtime = createAgentRuntime({ registry, llmFn });
 * const result = await runtime.run('What is stored under "foo"?');
 * console.log(result.content);
 * ```
 *
 * ---------------------------------------------------------------------------
 * MESSAGE SHAPES -- what actually gets pushed onto the running conversation
 * (`.getMessages()`), in order, for one tool-calling round:
 *
 *   1. `{ role: 'user', content: string }` -- appended once per `run()` call,
 *      from its `userMessage` argument.
 *   2. `{ role: 'assistant', content, toolCalls }` -- the raw `llmFn`
 *      response, tagged with `role: 'assistant'`, appended VERBATIM (whatever
 *      `content`/`toolCalls` `llmFn` returned) so the next `llmFn` call sees
 *      an accurate record of what the assistant itself said/asked for. This
 *      also means a response with BOTH `content` and `toolCalls` set is
 *      preserved faithfully (some vendor APIs allow an assistant turn to
 *      include prose alongside a tool call) -- `run()` only treats a
 *      response as the FINAL answer when `toolCalls` is absent/empty,
 *      matching the plan's stop condition exactly.
 *   3. One `{ role: 'tool', tool_call_id, name, content }` entry PER
 *      dispatched tool call, in the same order `toolCalls` was returned:
 *      - `tool_call_id` echoes the call's `id`, so an `llmFn` can correlate
 *        results back to requests (the OpenAI/Anthropic tool-result
 *        convention this shape is deliberately modeled on, per the plan's
 *        own suggested shape).
 *      - `name` is included too (redundant with `tool_call_id` for a
 *        vendor that tracks calls by id, but convenient for `llmFn`
 *        implementations/log output that key off the tool name directly).
 *      - `content` is always a STRING: `JSON.stringify(result)` of whatever
 *        `tool.execute()` resolved to (`BrowserTool.execute()` results are
 *        typically plain objects like `{success, output, error}`, not
 *        strings -- see `tools.mjs`'s existing tools -- so this file
 *        normalizes to a string the same way most chat APIs expect tool
 *        results to arrive).
 *
 * ---------------------------------------------------------------------------
 * DISPATCH -- a single bad tool call must not crash the loop
 *
 * For each `{id, name, arguments}` in `toolCalls`:
 *   - `registry.get(name)` not found -- synthesized error result
 *     `{ success: false, error: 'Unknown tool "<name>"' }` is appended as
 *     that call's tool-result message; NO exception is thrown and the loop
 *     continues normally (an LLM hallucinating a tool name is exactly the
 *     kind of thing that should come back as information for the NEXT
 *     `llmFn` call, not a crash).
 *   - `tool.execute(arguments)` throws OR rejects -- caught, synthesized as
 *     `{ success: false, error: err.message || String(err) }`, same
 *     treatment. This matches `mesh-compute.mjs`'s/`mesh-agent-swarm.mjs`'s
 *     own "a failing inbound request gets an explicit error response, not a
 *     silent drop or a crash" precedent, one layer over: here the "response"
 *     is a tool-result message fed back into the SAME conversation loop
 *     rather than a wire reply to a remote peer.
 *   - Every tool call in a batch is dispatched even if an earlier one in the
 *     same batch failed -- one failure does not skip the rest.
 *
 * ---------------------------------------------------------------------------
 * `maxTurns` -- DEFAULT 10, RETURNS A TRUNCATED RESULT RATHER THAN THROWING
 *
 * A "turn" here is one `llmFn` call. If `maxTurns` calls to `llmFn` have all
 * come back asking for more tool calls (never a plain `content`-only
 * response), `run()` stops issuing further `llmFn` calls and resolves with
 * `{ content: <last assistant content, if any>, toolCalls: <last requested
 * calls>, truncated: true }` instead of throwing.
 *
 * Rationale (this file's own judgment call, since the plan left it open):
 * an agent loop hitting a turn limit is a normal, expected outcome for a
 * long-running or looping task -- not necessarily a bug -- and a real
 * caller building a chat UI (the `.getMessages()`/`.reset()` surface below
 * exists specifically for that use case) is much better served by a
 * partial result it can inspect, show to a user, or resume from (the
 * conversation is left exactly as it stood -- nothing is rolled back) than
 * by a thrown exception that forces it to unwind and lose that state. A
 * caller that genuinely wants a hard failure on truncation can simply check
 * `result.truncated` and throw itself.
 *
 * ---------------------------------------------------------------------------
 * No browser-only imports at module level.
 */

/**
 * @param {unknown} registry
 * @returns {boolean}
 */
function looksLikeRegistry(registry) {
  return !!registry
    && typeof registry.listSpecs === 'function'
    && typeof registry.get === 'function';
}

/** Default cap on `llmFn` round-trips per `run()` call -- see module doc comment's "maxTurns" section. */
const DEFAULT_MAX_TURNS = 10;

/**
 * Build a `{success: false, error}`-shaped result for a tool call this loop
 * could not (or did not) run -- see module doc comment's "DISPATCH" section.
 * @param {string} error
 * @returns {{success: false, error: string}}
 */
function toolError(error) {
  return { success: false, error };
}

/**
 * Run every requested tool call against `registry`, one at a time, in order.
 * Neither an unknown tool name nor a throwing/rejecting `.execute()` stops
 * the batch -- see module doc comment's "DISPATCH" section.
 *
 * @param {import('./compat.mjs').BrowserToolRegistry} registry
 * @param {Array<{id: string, name: string, arguments: object}>} toolCalls
 * @param {(event: string, data: object) => void} log
 * @returns {Promise<Array<{role: 'tool', tool_call_id: string, name: string, content: string}>>}
 */
async function dispatchToolCalls(registry, toolCalls, log) {
  const results = [];
  for (const call of toolCalls) {
    const { id, name, arguments: args } = call || {};
    let result;
    const tool = name != null ? registry.get(name) : undefined;
    if (!tool) {
      result = toolError(`Unknown tool "${name}"`);
      log('agent-runtime:unknown-tool', { id, name });
    } else {
      try {
        result = await tool.execute(args);
      } catch (err) {
        result = toolError(err?.message || String(err));
        log('agent-runtime:tool-threw', { id, name, error: result.error });
      }
    }
    results.push({
      role: 'tool',
      tool_call_id: id,
      name,
      content: JSON.stringify(result),
    });
  }
  return results;
}

/**
 * Create a standalone agent tool-calling runtime: a running conversation
 * plus a dispatch loop between a caller-supplied `llmFn` and a
 * `BrowserToolRegistry`. See module doc comment for the full design
 * writeup (required dependencies, the `llmFn` shape with a worked example,
 * message shapes, dispatch error handling, `maxTurns` behavior).
 *
 * @param {object} opts
 * @param {import('./compat.mjs').BrowserToolRegistry} opts.registry
 *   REQUIRED. Duck-typed (`.listSpecs`/`.get` both functions) rather than
 *   `instanceof`-checked -- see module doc comment.
 * @param {(messages: object[], toolSpecs: object[]) => Promise<{content?: string, toolCalls?: Array<{id: string, name: string, arguments: object}>}>} opts.llmFn
 *   REQUIRED. No default implementation is provided by this package -- see
 *   module doc comment.
 * @param {number} [opts.maxTurns=10] - Constructor-level default cap on
 *   `llmFn` round-trips per `run()` call; overridable per-call via
 *   `run(userMessage, { maxTurns })`.
 * @param {(event: string, data: object) => void} [opts.onLog]
 * @returns {{
 *   run: (userMessage: string, runOpts?: {maxTurns?: number}) => Promise<{content?: string, toolCalls?: object[], truncated?: boolean}>,
 *   getMessages: () => object[],
 *   reset: () => void,
 * }}
 */
export function createAgentRuntime({ registry, llmFn, maxTurns = DEFAULT_MAX_TURNS, onLog } = {}) {
  if (!looksLikeRegistry(registry)) {
    throw new TypeError(
      'createAgentRuntime: registry is required (a BrowserToolRegistry-shaped object ' +
      'implementing listSpecs() and get(name) -- see compat.mjs\'s BrowserToolRegistry) -- got ' +
      (registry && registry.constructor ? registry.constructor.name : String(registry))
    );
  }
  if (typeof llmFn !== 'function') {
    throw new TypeError(
      'createAgentRuntime: llmFn is required (an async function ' +
      '(messages, toolSpecs) -> {content?, toolCalls?} -- see module doc comment for the ' +
      'exact shape and a worked example). No default llmFn is provided by this package.'
    );
  }

  const log = onLog || (() => {});

  /** @type {object[]} */
  let messages = [];

  /**
   * @param {string} userMessage
   * @param {{maxTurns?: number}} [runOpts]
   * @returns {Promise<{content?: string, toolCalls?: object[], truncated?: boolean}>}
   */
  async function run(userMessage, runOpts = {}) {
    const turnLimit = runOpts.maxTurns ?? maxTurns;

    messages.push({ role: 'user', content: userMessage });

    let lastResponse;
    for (let turn = 0; turn < turnLimit; turn++) {
      const toolSpecs = registry.listSpecs();
      const response = await llmFn(messages, toolSpecs);
      lastResponse = response;

      messages.push({ role: 'assistant', ...response });

      const toolCalls = response && Array.isArray(response.toolCalls) ? response.toolCalls : [];
      if (toolCalls.length === 0) {
        log('agent-runtime:final', { turn, content: response?.content });
        return { content: response?.content, toolCalls: undefined };
      }

      log('agent-runtime:tool-calls', { turn, count: toolCalls.length, names: toolCalls.map((c) => c?.name) });
      const toolResults = await dispatchToolCalls(registry, toolCalls, log);
      messages.push(...toolResults);
    }

    log('agent-runtime:truncated', { maxTurns: turnLimit });
    return {
      content: lastResponse?.content,
      toolCalls: lastResponse?.toolCalls,
      truncated: true,
    };
  }

  return {
    run,
    /** @returns {object[]} a copy of the running conversation -- mutating it does not affect the runtime's own state. */
    getMessages: () => [...messages],
    /** Clears the running conversation back to empty, e.g. to start a fresh chat in the same runtime instance. */
    reset: () => { messages = []; },
  };
}
