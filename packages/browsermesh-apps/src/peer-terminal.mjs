/**
 * peer-terminal.mjs -- Remote terminal/shell execution over the mesh.
 *
 * Allows one peer to execute commands on another's shell through
 * `TerminalHost` (accepts and executes) and `TerminalClient` (sends and
 * awaits results). Built as a `MeshService` (`mesh-service.mjs`, the same
 * `attach(peerNode, ctx) -> {teardown, api}` convention `mesh-rpc.mjs`/
 * `peer-files.mjs`/`peer-escrow.mjs` etc. already use), NOT on top of
 * `peer-session.mjs`'s `PeerSession`/`SessionManager` -- see "Migration
 * history" below.
 *
 * ---------------------------------------------------------------------------
 * Migration history (issue #84, Phase 10 of the app-layer migration plan;
 * blocked on issue #86 until its design pass resolved what gates remote
 * shell execution):
 *
 * This file used to depend on `peer-session.mjs`'s `PeerSession` --
 * `TerminalHost`'s constructor called `session.registerHandler('terminal', ...)`
 * directly and `#handleCommand()` called `session.requireCapability('terminal:execute')`/
 * `session.send()`/`session.remotePodId`; `TerminalClient` did the same for
 * its own `registerHandler('terminal', ...)`/`session.send()`. Nothing in
 * this repo ever constructed a live `PeerSession` (`SessionManager` is never
 * instantiated outside its own tests) -- exactly the same dead-dependency
 * situation Phase 8 (`peer-files.mjs`) and Phase 9 (`peer-chat.mjs`) already
 * found and fixed -- so this migration removes the `PeerSession` dependency
 * entirely rather than bridging it.
 *
 * Issue #86's resolved design pass (see that issue's closing comment) settled
 * TWO things this file depends on directly:
 *
 *   1. GATE MECHANISM: `ctx.registry.checkAccess(pubKey, resource, action)`,
 *      the SAME mechanism `mesh-relay-host.mjs` already used and Phases 3/4/
 *      8/9 of this plan (`peer-escrow.mjs`/`mesh-verification.mjs`/
 *      `peer-files.mjs`/`peer-chat.mjs`) independently converged on for their
 *      own peer-initiated risky actions -- NOT `WasmSandbox`
 *      (`browsermesh-core/src/capabilities.mjs`), which has zero real target
 *      anywhere in this repo (no `WebAssembly.*` calls, no `.wasm` files),
 *      and not `browsermesh-kernel`'s tenant capability model, which gates
 *      *local* application code with no concept of a remote requester.
 *      `session.requireCapability('terminal:execute')` (a static,
 *      per-session capability list check) becomes
 *      `checkAccess(fromPubKey, TERMINAL_RESOURCE, TERMINAL_ACTION)` --
 *      live, per-request, per-sender ACL/capability-token checking via
 *      `PeerRegistry` (`peer-registry.mjs`), called from the SAME place in
 *      the request-handling flow the old `requireCapability()` call sat
 *      (`TerminalHost#handleRequest()`'s step 1, before any command
 *      validation/allowlist/execution) -- see `TERMINAL_RESOURCE`/
 *      `TERMINAL_ACTION` below. No default template in
 *      `@johnhenry/browsermesh-core`'s `acl.mjs` (`guest`/`collaborator`/
 *      `admin`) grants `terminal:execute` -- unlike `files:read`/
 *      `chat:*`/`compute:submit`, a peer gets NOTHING here until the node
 *      operator explicitly calls `registry.grantCapabilities(peerPubKey,
 *      ['terminal:execute'])`, a deliberate omission given the subject
 *      matter (real remote command execution, not a read/write file or chat
 *      message).
 *      A single coarse `'terminal'`/`'execute'` scope (not per-command or
 *      per-target-pod) is used -- mirroring `mesh-verification.mjs`'s own
 *      single `'verification'`/`'execute'` gate for the same reason that
 *      file documents: there is no natural per-resource id to scope against
 *      the way `peer-escrow.mjs`'s per-contract `escrow:<contractId>:release`
 *      grants exist (a contract id is created by `create()` and can be
 *      auto-granted to its real payer/payee; a terminal command has no
 *      equivalent identity to grant against before it's even sent). A node
 *      operator who wants finer-grained terminal access per peer should grant/
 *      revoke the single `terminal:execute` scope per peer via
 *      `registry.grantCapabilities()`/`revokeCapabilities()`, and rely on
 *      `TerminalHost`'s own `allowedCommands`/`blockedCommands` allow/deny
 *      list (unchanged from the pre-migration version) for per-command
 *      restriction.
 *
 *   2. EXECUTION BACKEND: bring-your-own, REQUIRED, no default shipped.
 *      Neither the pre-migration nor this file has ever had a real `shell`
 *      implementation anywhere in this repo -- only `createMockShell()` in
 *      this file's own test. This migration does NOT add one (no
 *      `child_process`, no OS command execution) -- that would be a much
 *      bigger, separately-decided scope. `createTerminalService()` requires
 *      `opts.shell` (an object with `execute(command) -> {output, exitCode}`);
 *      omitting it throws immediately when the descriptor is `attach()`ed
 *      (the same point `TerminalHost`'s own pre-migration constructor already
 *      threw at), and `createMeshNode({enableTerminal: true})` throws even
 *      earlier, before attaching anything, if `terminalOptions.shell` is
 *      missing -- mirroring `enableEscrow`'s required-dependency-throws-if-
 *      missing precedent for `escrowOptions.creditLedger` (see
 *      `mesh-bootstrap.mjs`). This is deliberate, safe-by-construction
 *      design: nobody gets real remote shell execution just by flipping
 *      `enableTerminal: true` -- they must also consciously wire up a real
 *      executor.
 *
 * `TerminalHost#handleRequest()`'s command-filtering/execution/truncation
 * logic (`isCommandAllowed()`, blocklist-always-wins-over-allowlist,
 * `maxOutputLength` truncation) is UNCHANGED from the `PeerSession`-era
 * version -- only the transport/correlation/authorization plumbing changed:
 *   - `TerminalHost` no longer owns "who do I reply to" (a `PeerSession`
 *     bound to exactly one remote peer) -- `handleRequest(fromPubKey, payload)`
 *     is now a pure function that COMPUTES and RETURNS a response (or `null`
 *     for an informational resize event, which needs no response); the
 *     caller (`createTerminalService()`'s `attach()`, below) sends it via
 *     `ctx.sendTo()`. This is the same necessary shape change `peer-files.mjs`
 *     went through: a `MeshService` is attached once per NODE and can be
 *     asked to execute commands by any connected peer holding
 *     `terminal:execute`, not once per peer-pair the way a `PeerSession` was.
 *   - `TerminalClient` no longer wraps one `PeerSession` bound to one remote
 *     peer -- `execute(pubKey, command, opts)`/`sendResize(pubKey, cols, rows)`
 *     now take a leading `pubKey` argument, since one `TerminalClient` (like
 *     `peer-files.mjs`'s `FileClient`) can request execution from ANY
 *     connected peer, not just one fixed session. Internally it still does
 *     exactly what it did before: generate a `requestId`, track a
 *     `{resolve, reject, timer}` in a pending-requests map, and correlate the
 *     eventual response by that id -- this was ALREADY a self-contained
 *     `requestId`-based correlation mechanism (not something `PeerSession`
 *     provided), so no new correlation primitive had to be invented; it's the
 *     exact same shape `peer-files.mjs`'s `FileClient` and `mesh-rpc.mjs`'s
 *     `request()` use. The one addition: each pending entry also records the
 *     `pubKey` the request targeted, and `handleResponse()` ignores a reply
 *     from any OTHER peer even if it happens to guess/replay a `requestId` --
 *     a property the old design got "for free" (a `PeerSession`'s transport
 *     only ever delivered messages from the one peer it was bound to) that a
 *     shared, node-wide `onIncomingData()` subscription does not.
 *
 * `createTerminalService()` is ONE `MeshService` covering both directions
 * (hosting a shell to others, and requesting execution from others) -- both
 * share the same `terminal-request`/`terminal-response` envelope-type pair
 * and the same `ctx.onIncomingData()` subscription, mirroring
 * `peer-files.mjs`'s `createFileShareService()` exactly.
 *
 * Run tests:
 *   node --import ./test/_setup-globals.mjs --test test/peer-terminal.test.mjs
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TERMINAL_DEFAULTS = Object.freeze({
  maxOutputLength: 65536,    // 64KB
  timeout: 30000,            // 30s
  blockedCommands: ['exit', 'shutdown', 'reboot', 'halt', 'poweroff'],
})

/** `ctx.registry.checkAccess()` resource name used for exec requests (see module doc comment's "Migration history", point 1). */
export const TERMINAL_RESOURCE = 'terminal'
/** `ctx.registry.checkAccess()` action name used for exec requests. A single coarse scope -- see module doc comment for why there is no finer-grained per-command/per-target scope. */
export const TERMINAL_ACTION = 'execute'

/** Default `envelope.type` for a terminal request (exec or resize), on the shared `ctx.onIncomingData()` bus. */
const DEFAULT_TERMINAL_REQUEST_ENVELOPE_TYPE = 'terminal-request'
/** Default `envelope.type` for a terminal response. */
const DEFAULT_TERMINAL_RESPONSE_ENVELOPE_TYPE = 'terminal-response'

// ---------------------------------------------------------------------------
// Internal — extract the command name (first token) from a command string.
// ---------------------------------------------------------------------------

/**
 * Extract the first token from a command string after trimming.
 * Handles quoted prefixes (e.g. `"my cmd" arg`) by stripping quotes.
 *
 * @param {string} command - Full command string
 * @returns {string} First token, lowercased
 */
function extractCommandName(command) {
  const trimmed = (command || '').trim()
  if (!trimmed) return ''

  // Handle quoted first token
  if (trimmed[0] === '"' || trimmed[0] === "'") {
    const quote = trimmed[0]
    const end = trimmed.indexOf(quote, 1)
    if (end > 1) {
      return trimmed.slice(1, end).toLowerCase()
    }
    // Unterminated quote — strip leading quote and fall through
  }

  // Split on whitespace and take first token, strip any remaining quotes
  const first = trimmed.split(/\s+/)[0].replace(/^["']|["']$/g, '')
  return first.toLowerCase()
}

// ---------------------------------------------------------------------------
// TerminalHost
// ---------------------------------------------------------------------------

/**
 * Serves terminal-execution requests from the local shell to remote peers.
 *
 * Framework-agnostic: `handleRequest()` is a pure function that computes and
 * RETURNS a response (or `null` for an informational resize event), it does
 * not send anything itself -- see module doc comment's "Migration history".
 * `createTerminalService()` (below) is what actually wires this to
 * `ctx.onIncomingData()`/`ctx.sendTo()`.
 */
export class TerminalHost {
  /** @type {object} shell with execute(command) → { output, exitCode } */
  #shell

  /** @type {Set<string>|null} null means all commands allowed (minus blocked) */
  #allowedCommands

  /** @type {Set<string>} always blocked */
  #blockedCommands

  /** @type {number} */
  #maxOutputLength

  /** @type {Function} */
  #onLog

  /** @type {(fromPubKey: string) => ({allowed: boolean, reason?: string})} */
  #checkAccess

  /** @type {number} commands executed */
  #executionCount = 0

  /**
   * @param {object} opts
   * @param {object} opts.shell - Object with execute(command) → { output, exitCode }.
   *   REQUIRED -- there is no default shell (see module doc comment's
   *   "Migration history", point 2). Constructing a `TerminalHost` with no
   *   real `shell` throws immediately.
   * @param {string[]|Set<string>} [opts.allowedCommands] - Whitelist; null/undefined means all allowed
   * @param {string[]|Set<string>} [opts.blockedCommands] - Always blocked commands
   * @param {number} [opts.maxOutputLength=65536] - Truncate output beyond this length
   * @param {Function} [opts.onLog] - Logging callback
   * @param {(fromPubKey: string) => ({allowed: boolean, reason?: string})} [opts.checkAccess]
   *   Capability check for a given requester. `createTerminalService()`
   *   supplies `(fromPubKey) => ctx.registry.checkAccess(fromPubKey, TERMINAL_RESOURCE, TERMINAL_ACTION)`.
   *   Defaults to permissive (`{ allowed: true }` for everyone) when
   *   constructed directly without one -- a `TerminalHost` built by hand
   *   (e.g. in a unit test) has no registry of its own to consult; supplying
   *   real gating is the caller's responsibility, exactly like
   *   `peer-files.mjs`'s `FileHost`.
   */
  constructor({ shell, allowedCommands, blockedCommands, maxOutputLength, onLog, checkAccess }) {
    if (!shell || typeof shell.execute !== 'function') {
      throw new Error('shell with execute() method is required')
    }

    this.#shell = shell
    this.#onLog = onLog || (() => {})
    this.#maxOutputLength = maxOutputLength ?? TERMINAL_DEFAULTS.maxOutputLength
    this.#checkAccess = typeof checkAccess === 'function' ? checkAccess : () => ({ allowed: true })

    // Normalize allowedCommands
    if (allowedCommands != null) {
      this.#allowedCommands = new Set(
        (Array.isArray(allowedCommands) ? allowedCommands : [...allowedCommands])
          .map(c => c.toLowerCase())
      )
    } else {
      this.#allowedCommands = null
    }

    // Normalize blockedCommands — merge with defaults
    const defaultBlocked = TERMINAL_DEFAULTS.blockedCommands
    const userBlocked = blockedCommands
      ? (Array.isArray(blockedCommands) ? blockedCommands : [...blockedCommands])
      : []
    this.#blockedCommands = new Set(
      [...defaultBlocked, ...userBlocked].map(c => c.toLowerCase())
    )
  }

  // -- Request handling -------------------------------------------------------

  /**
   * Handle an incoming terminal request from `fromPubKey`.
   *
   * 1. Handles resize events (informational -- returns `null`, no response needed)
   * 2. Checks access via the injected `checkAccess`
   * 3. Validates command is a non-empty string
   * 4. Validates command against allowlist/blocklist
   * 5. Executes on the local shell, truncating output if necessary
   *
   * @param {string} fromPubKey - Requesting peer's public key
   * @param {object} payload - `{ command, requestId, resize }`
   * @returns {Promise<{requestId: string|null, output: string, exitCode: number, truncated?: boolean}|null>}
   *   `null` for a resize event (no response should be sent).
   */
  async handleRequest(fromPubKey, payload) {
    const { command, requestId, resize } = payload || {}

    // 1. Handle resize events (informational, no response needed)
    if (resize && typeof resize === 'object' && !command) {
      this.#onLog(2, `Terminal resize from ${fromPubKey}: ${resize.cols}x${resize.rows}`)
      return null
    }

    const response = { requestId: requestId || null }

    // 2. Check access
    const { allowed, reason } = this.#checkAccess(fromPubKey) || {}
    if (!allowed) {
      response.output = `Error: capability "${TERMINAL_RESOURCE}:${TERMINAL_ACTION}" not granted for ${fromPubKey}${reason ? ` (${reason})` : ''}`
      response.exitCode = 1
      response.denied = true
      this.#onLog(1, `Denied terminal request from ${fromPubKey}${reason ? `: ${reason}` : ''}`)
      return response
    }

    // 3. Validate command is a non-empty string
    if (!command || typeof command !== 'string') {
      response.output = 'Error: command must be a non-empty string'
      response.exitCode = 1
      return response
    }

    // 4. Check against allowlist / blocklist
    if (!this.isCommandAllowed(command)) {
      const name = extractCommandName(command)
      response.output = `Error: command "${name}" is not allowed`
      response.exitCode = 126
      this.#onLog(1, `Blocked terminal command "${name}" from ${fromPubKey}`)
      return response
    }

    try {
      // 5. Execute on the local shell
      this.#onLog(2, `Executing terminal command from ${fromPubKey}: ${command}`)
      const result = await this.#shell.execute(command)
      this.#executionCount++

      let output = result.output != null ? String(result.output) : ''
      let truncated = false

      if (output.length > this.#maxOutputLength) {
        output = output.slice(0, this.#maxOutputLength)
        truncated = true
      }

      response.output = output
      response.exitCode = result.exitCode ?? 0
      if (truncated) {
        response.truncated = true
      }
    } catch (err) {
      response.output = `Error: ${err.message}`
      response.exitCode = 1
      this.#onLog(0, `Terminal command error: ${err.message}`)
    }

    return response
  }

  // -- Command filtering ----------------------------------------------------

  /**
   * Check whether a command string is allowed to execute.
   *
   * Extracts the first token (command name), checks against the
   * blocklist first, then the allowlist.
   *
   * @param {string} command - Full command string
   * @returns {boolean}
   */
  isCommandAllowed(command) {
    const name = extractCommandName(command)
    if (!name) return false

    // Blocklist always wins
    if (this.#blockedCommands.has(name)) {
      return false
    }

    // If no allowlist is set, all non-blocked commands are allowed
    if (this.#allowedCommands === null) {
      return true
    }

    // Check against allowlist
    return this.#allowedCommands.has(name)
  }

  // -- Serialization --------------------------------------------------------

  /**
   * Serialize to a JSON-safe object.
   *
   * @returns {object}
   */
  toJSON() {
    return {
      allowedCommands: this.#allowedCommands ? [...this.#allowedCommands] : null,
      blockedCommands: [...this.#blockedCommands],
      maxOutputLength: this.#maxOutputLength,
      executionCount: this.#executionCount,
    }
  }
}

// ---------------------------------------------------------------------------
// TerminalClient
// ---------------------------------------------------------------------------

/**
 * Client-side interface for executing commands on a remote peer's terminal.
 *
 * One `TerminalClient` can request execution from ANY connected peer (not
 * bound to a single remote peer the way the `PeerSession`-era version was)
 * -- every public method takes a leading `pubKey` argument. Requests are
 * correlated to their responses by a generated `requestId`, exactly like the
 * `PeerSession`-era version already did (see module doc comment's
 * "Migration history"); the only addition is also recording which `pubKey`
 * a request targeted, so a response claiming a stale/guessed `requestId`
 * from the WRONG peer is ignored rather than resolving/rejecting the wrong
 * caller's promise -- a property a per-peer `PeerSession` transport provided
 * for free that a shared, node-wide subscription does not.
 */
export class TerminalClient {
  /** @type {(pubKey: string, payload: object) => Promise<void>} */
  #sendRequest

  /** @type {Map<string, { resolve: Function, reject: Function, timer: *, pubKey: string }>} */
  #pendingRequests = new Map()

  /** @type {number} default timeout in ms */
  #timeout

  /** @type {Function} */
  #onLog

  /** @type {Map<string, Set<Function>>} */
  #listeners = new Map()

  /**
   * @param {object} opts
   * @param {(pubKey: string, payload: object) => Promise<void>} opts.sendRequest
   *   Sends a `terminal-request`-shaped payload to `pubKey`. `createTerminalService()`
   *   supplies `(pubKey, payload) => ctx.sendTo(pubKey, 'terminal-request', payload)`.
   * @param {number} [opts.timeout=30000] - Default timeout for commands in ms
   * @param {Function} [opts.onLog] - Logging callback
   */
  constructor({ sendRequest, timeout, onLog }) {
    if (typeof sendRequest !== 'function') {
      throw new Error('sendRequest function is required')
    }

    this.#sendRequest = sendRequest
    this.#timeout = timeout ?? TERMINAL_DEFAULTS.timeout
    this.#onLog = onLog || (() => {})
  }

  // -- Command execution ----------------------------------------------------

  /**
   * Execute a command on a remote peer's terminal.
   *
   * Sends the command with a unique requestId, then waits for the
   * matching response or times out.
   *
   * @param {string} pubKey - Remote peer to execute on
   * @param {string} command - Command to execute
   * @param {object} [opts]
   * @param {number} [opts.timeout] - Override the default timeout for this command
   * @returns {Promise<{ output: string, exitCode: number, truncated?: boolean }>}
   */
  async execute(pubKey, command, opts) {
    if (!pubKey || typeof pubKey !== 'string') {
      throw new Error('pubKey must be a non-empty string')
    }
    if (!command || typeof command !== 'string') {
      throw new Error('command must be a non-empty string')
    }

    const requestId = crypto.randomUUID()
    const timeoutMs = opts?.timeout ?? this.#timeout

    return new Promise((resolve, reject) => {
      // Set up timeout
      const timer = setTimeout(() => {
        const pending = this.#pendingRequests.get(requestId)
        if (pending) {
          this.#pendingRequests.delete(requestId)
          const err = new Error(`Terminal command timed out after ${timeoutMs}ms`)
          err.code = 'TERMINAL_TIMEOUT'
          this.#emit('error', { requestId, error: err.message })
          reject(err)
        }
      }, timeoutMs)

      // Register pending request
      this.#pendingRequests.set(requestId, { resolve, reject, timer, pubKey })

      // Send command to remote host
      Promise.resolve(this.#sendRequest(pubKey, { command, requestId }))
        .then(() => {
          this.#onLog(2, `Sent terminal command to ${pubKey}: ${command}`)
        })
        .catch((err) => {
          clearTimeout(timer)
          this.#pendingRequests.delete(requestId)
          reject(err)
        })
    })
  }

  // -- Resize ---------------------------------------------------------------

  /**
   * Send a resize event to a remote peer's terminal (informational).
   * Does not wait for a response.
   *
   * @param {string} pubKey - Remote peer to notify
   * @param {number} cols - Number of columns
   * @param {number} rows - Number of rows
   */
  sendResize(pubKey, cols, rows) {
    if (!pubKey || typeof pubKey !== 'string') {
      throw new Error('pubKey must be a non-empty string')
    }
    Promise.resolve(this.#sendRequest(pubKey, { resize: { cols, rows } })).catch((err) => {
      this.#onLog(0, `Failed to send terminal resize to ${pubKey}: ${err.message}`)
    })
  }

  // -- Response handling ------------------------------------------------------

  /**
   * Handle an incoming terminal response. Matches by requestId (AND the peer
   * it was sent to -- see class doc comment) and resolves the pending
   * promise.
   *
   * @param {string} fromPubKey - Peer the response actually arrived from
   * @param {object} payload - `{ requestId, output, exitCode, truncated? }`
   */
  handleResponse(fromPubKey, payload) {
    const { requestId, output, exitCode, truncated } = payload || {}

    if (!requestId) return

    const pending = this.#pendingRequests.get(requestId)
    if (!pending) return

    // A response claiming this requestId but arriving from a different peer
    // than the one it was sent to is never valid -- ignore it rather than
    // resolving the wrong caller's promise (see class doc comment).
    if (pending.pubKey !== fromPubKey) return

    // Clean up
    clearTimeout(pending.timer)
    this.#pendingRequests.delete(requestId)

    const result = {
      output: output != null ? String(output) : '',
      exitCode: exitCode ?? 0,
    }
    if (truncated) {
      result.truncated = true
    }

    // Emit output event
    this.#emit('output', result)

    // Resolve the pending promise
    pending.resolve(result)
  }

  // -- Events ---------------------------------------------------------------

  /**
   * Register a listener for a terminal client event.
   * Events: 'output', 'error'
   *
   * @param {string} event - Event name
   * @param {Function} cb - Callback function
   */
  on(event, cb) {
    if (!this.#listeners.has(event)) {
      this.#listeners.set(event, new Set())
    }
    this.#listeners.get(event).add(cb)
  }

  /**
   * Remove a listener for a terminal client event.
   *
   * @param {string} event - Event name
   * @param {Function} cb - Callback function
   */
  off(event, cb) {
    const set = this.#listeners.get(event)
    if (set) set.delete(cb)
  }

  /**
   * Emit an event to all registered listeners.
   *
   * @param {string} event - Event name
   * @param {*} data - Event data
   */
  #emit(event, data) {
    const set = this.#listeners.get(event)
    if (!set) return
    for (const cb of [...set]) {
      try {
        cb(data)
      } catch {
        /* listener errors do not propagate */
      }
    }
  }

  // -- Cleanup --------------------------------------------------------------

  /**
   * Close the terminal client. Rejects all pending requests and clears
   * listeners.
   */
  close() {
    for (const [, pending] of this.#pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(new Error('TerminalClient closed'))
    }
    this.#pendingRequests.clear()
    this.#listeners.clear()
  }

  // -- Serialization --------------------------------------------------------

  /**
   * Serialize to a JSON-safe object.
   *
   * @returns {object}
   */
  toJSON() {
    return {
      pendingRequests: this.#pendingRequests.size,
      timeout: this.#timeout,
    }
  }
}

// ---------------------------------------------------------------------------
// createTerminalService -- the MeshService descriptor (issue #84, Phase 10)
// ---------------------------------------------------------------------------

/**
 * Build a `MeshService` descriptor (`mesh-service.mjs`) wiring `TerminalHost`/
 * `TerminalClient` onto `ctx.sendTo()`/`ctx.onIncomingData()`. One service
 * covers both directions -- hosting a shell to other peers (always, since
 * `shell` is required -- see below) and requesting execution from other
 * peers (always available via the returned `api`) -- see module doc comment
 * for why this isn't split into two descriptors.
 *
 * `shell` is REQUIRED -- unlike `peer-files.mjs`'s `fs` (optional, "client-
 * only" if omitted), there is no client-only mode here: `attach()` throws
 * immediately (via `TerminalHost`'s own constructor check) if `opts.shell`
 * is missing or doesn't implement `execute()`. See module doc comment's
 * "Migration history", point 2, for why this is deliberate. A node that only
 * ever wants to REQUEST execution from other peers still must supply *some*
 * `shell` to attach this service at all today -- if a request-only mode
 * becomes a real need, that's a follow-up, not a silent default.
 *
 * @param {object} opts
 * @param {object} opts.shell - Object with `execute(command) -> {output, exitCode}`.
 *   REQUIRED. No default is provided by this package (see module doc comment).
 * @param {string[]|Set<string>} [opts.allowedCommands] - See `TerminalHost`.
 * @param {string[]|Set<string>} [opts.blockedCommands] - See `TerminalHost`.
 * @param {number} [opts.maxOutputLength] - See `TerminalHost`.
 * @param {number} [opts.timeout] - See `TerminalClient`.
 * @param {Function} [opts.onLog]
 * @param {string} [opts.accessResource='terminal'] - `resource` passed to
 *   `ctx.registry.checkAccess()` for inbound exec requests (see `TERMINAL_RESOURCE`).
 * @param {string} [opts.accessAction='execute'] - `action` passed to
 *   `ctx.registry.checkAccess()` for inbound exec requests (see `TERMINAL_ACTION`).
 * @param {string} [opts.requestEnvelopeType='terminal-request']
 * @param {string} [opts.responseEnvelopeType='terminal-response']
 * @returns {import('./mesh-service.mjs').MeshService}
 */
export function createTerminalService(opts = {}) {
  const {
    shell,
    allowedCommands,
    blockedCommands,
    maxOutputLength,
    timeout,
    onLog,
    accessResource = TERMINAL_RESOURCE,
    accessAction = TERMINAL_ACTION,
    requestEnvelopeType = DEFAULT_TERMINAL_REQUEST_ENVELOPE_TYPE,
    responseEnvelopeType = DEFAULT_TERMINAL_RESPONSE_ENVELOPE_TYPE,
  } = opts
  const log = onLog || (() => {})

  return {
    name: 'terminal',

    attach(peerNode, ctx) {
      // Throws here (inside attach(), not createTerminalService() itself) if
      // shell is missing/invalid -- mirrors peer-escrow.mjs's EscrowManager
      // throwing inside createEscrowService()'s attach() when creditLedger
      // is missing. See module doc comment's "Migration history", point 2.
      const host = new TerminalHost({
        shell,
        allowedCommands,
        blockedCommands,
        maxOutputLength,
        onLog,
        checkAccess: (fromPubKey) => ctx.registry.checkAccess(fromPubKey, accessResource, accessAction),
      })

      const client = new TerminalClient({
        timeout,
        onLog,
        sendRequest: (pubKey, payload) => ctx.sendTo(pubKey, requestEnvelopeType, payload),
      })

      // Bridge TerminalClient's own pre-existing on()/off() events through
      // ctx.emit() -- see mesh-service.mjs's "Observability events" section
      // and peer-escrow.mjs's/mesh-verification.mjs's own bridging precedent.
      const onOutput = (data) => ctx.emit('terminal:output', data)
      const onError = (data) => ctx.emit('terminal:error', data)
      client.on('output', onOutput)
      client.on('error', onError)

      const unsubscribeRequests = ctx.onIncomingData(requestEnvelopeType, async (fromPubKey, msg) => {
        let response
        try {
          response = await host.handleRequest(fromPubKey, msg)
        } catch (err) {
          // TerminalHost#handleRequest() already catches every shell-execution
          // error itself -- reaching here would mean something unexpected
          // (e.g. checkAccess() throwing). Never let it become an unhandled
          // rejection or crash the shared onIncomingData() dispatch loop.
          log('terminal:request-handling-failed', { from: fromPubKey, requestId: msg?.requestId, error: err?.message || String(err) })
          response = { requestId: msg?.requestId ?? null, output: `Error: ${err?.message || String(err)}`, exitCode: 1 }
        }

        // null means an informational resize event -- no response to send.
        if (response === null) return

        if (response.denied) {
          ctx.emit('terminal:request-denied', { from: fromPubKey, requestId: response.requestId })
        } else {
          ctx.emit('terminal:request-served', { from: fromPubKey, requestId: response.requestId, exitCode: response.exitCode })
        }

        try {
          await ctx.sendTo(fromPubKey, responseEnvelopeType, response)
        } catch (err) {
          log('terminal:response-send-failed', { to: fromPubKey, requestId: response.requestId, error: err?.message || String(err) })
        }
      })

      const unsubscribeResponses = ctx.onIncomingData(responseEnvelopeType, (fromPubKey, msg) => {
        client.handleResponse(fromPubKey, msg)
      })

      const api = {
        host,
        client,
        execute: (pubKey, command, execOpts) => client.execute(pubKey, command, execOpts),
        sendResize: (pubKey, cols, rows) => client.sendResize(pubKey, cols, rows),
      }

      return {
        api,
        teardown() {
          client.off('output', onOutput)
          client.off('error', onError)
          unsubscribeRequests()
          unsubscribeResponses()
          client.close()
        },
      }
    },
  }
}

export { DEFAULT_TERMINAL_REQUEST_ENVELOPE_TYPE, DEFAULT_TERMINAL_RESPONSE_ENVELOPE_TYPE }
