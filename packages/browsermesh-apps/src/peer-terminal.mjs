/**
// STATUS: EXPERIMENTAL — complete implementation, not yet integrated into main application
 * clawser-peer-terminal.js -- Remote terminal access over peer sessions.
 *
 * Allows one peer to execute commands on another's virtual shell via
 * TerminalHost (accepts and executes) and TerminalClient (sends and
 * awaits results). Built on top of PeerSession's service handler system
 * using the 'terminal' service type.
 *
 * Dependencies are injected (PeerSession, shell).
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-peer-terminal.test.mjs
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TERMINAL_DEFAULTS = Object.freeze({
  maxOutputLength: 65536,    // 64KB
  timeout: 30000,            // 30s
  blockedCommands: ['exit', 'shutdown', 'reboot', 'halt', 'poweroff'],
})

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
 * Accepts incoming terminal requests from remote peers and executes
 * commands on the local shell.
 *
 * Registers a handler on the PeerSession for the 'terminal' service
 * type. Incoming command requests are validated against an allowlist /
 * blocklist before execution. The remote peer must hold the
 * 'terminal:execute' capability on the session.
 */
export class TerminalHost {
  /** @type {object} PeerSession */
  #session

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

  /** @type {number} commands executed */
  #executionCount = 0

  /**
   * @param {object} opts
   * @param {object} opts.session - PeerSession instance
   * @param {object} opts.shell - Object with execute(command) → { output, exitCode }
   * @param {string[]|Set<string>} [opts.allowedCommands] - Whitelist; null/undefined means all allowed
   * @param {string[]|Set<string>} [opts.blockedCommands] - Always blocked commands
   * @param {number} [opts.maxOutputLength=65536] - Truncate output beyond this length
   * @param {Function} [opts.onLog] - Logging callback
   */
  constructor({ session, shell, allowedCommands, blockedCommands, maxOutputLength, onLog }) {
    if (!session) {
      throw new Error('session is required')
    }
    if (!shell || typeof shell.execute !== 'function') {
      throw new Error('shell with execute() method is required')
    }

    this.#session = session
    this.#shell = shell
    this.#onLog = onLog || (() => {})
    this.#maxOutputLength = maxOutputLength ?? TERMINAL_DEFAULTS.maxOutputLength

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

    // Register handler on session for 'terminal' service type
    this.#session.registerHandler('terminal', (envelope) => this.#handleCommand(envelope))
  }

  // -- Command handling (private) -------------------------------------------

  /**
   * Handle an incoming terminal command request.
   *
   * 1. Checks 'terminal:execute' capability on session
   * 2. Validates command against allowlist/blocklist
   * 3. Executes on the local shell
   * 4. Truncates output if necessary
   * 5. Sends response back via session
   *
   * @param {object} envelope - Session envelope with payload
   */
  async #handleCommand(envelope) {
    const payload = envelope.payload || envelope
    const { command, requestId, resize } = payload

    // Build base response
    const response = { requestId: requestId || null }

    try {
      // 0. Handle resize events (informational, no response needed)
      if (resize && typeof resize === 'object' && !command) {
        this.#onLog(2, `Terminal resize from ${this.#session.remotePodId}: ${resize.cols}x${resize.rows}`)
        return
      }

      // 1. Check capability
      this.#session.requireCapability('terminal:execute')

      // 2. Validate command is a non-empty string
      if (!command || typeof command !== 'string') {
        response.output = 'Error: command must be a non-empty string'
        response.exitCode = 1
        this.#session.send('terminal', response)
        return
      }

      // 3. Check against allowlist / blocklist
      if (!this.isCommandAllowed(command)) {
        const name = extractCommandName(command)
        response.output = `Error: command "${name}" is not allowed`
        response.exitCode = 126
        this.#session.send('terminal', response)
        this.#onLog(1, `Blocked terminal command "${name}" from ${this.#session.remotePodId}`)
        return
      }

      // 4. Execute on the local shell
      this.#onLog(2, `Executing terminal command from ${this.#session.remotePodId}: ${command}`)
      const result = await this.#shell.execute(command)
      this.#executionCount++

      let output = result.output != null ? String(result.output) : ''
      let truncated = false

      // 5. Truncate if needed
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

    // Send response back
    this.#session.send('terminal', response)
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

  // -- Lifecycle ------------------------------------------------------------

  /**
   * Close the terminal host. Removes the handler from the session.
   */
  close() {
    this.#session.removeHandler('terminal')
  }

  // -- Serialization --------------------------------------------------------

  /**
   * Serialize to a JSON-safe object.
   *
   * @returns {object}
   */
  toJSON() {
    return {
      sessionId: this.#session.sessionId,
      localPodId: this.#session.localPodId,
      remotePodId: this.#session.remotePodId,
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
 * Sends command requests via the PeerSession and waits for responses
 * matched by requestId. Supports configurable timeout per command and
 * emits events for output and errors.
 */
export class TerminalClient {
  /** @type {object} PeerSession */
  #session

  /** @type {Map<string, { resolve: Function, reject: Function, timer: * }>} */
  #pendingRequests = new Map()

  /** @type {number} default timeout in ms */
  #timeout

  /** @type {Function} */
  #onLog

  /** @type {Map<string, Set<Function>>} */
  #listeners = new Map()

  /**
   * @param {object} opts
   * @param {object} opts.session - PeerSession instance
   * @param {number} [opts.timeout=30000] - Default timeout for commands in ms
   * @param {Function} [opts.onLog] - Logging callback
   */
  constructor({ session, timeout, onLog }) {
    if (!session) {
      throw new Error('session is required')
    }

    this.#session = session
    this.#timeout = timeout ?? TERMINAL_DEFAULTS.timeout
    this.#onLog = onLog || (() => {})

    // Register handler on session for 'terminal' response messages
    this.#session.registerHandler('terminal', (envelope) => this.#handleResponse(envelope))
  }

  // -- Command execution ----------------------------------------------------

  /**
   * Execute a command on the remote peer's terminal.
   *
   * Sends the command with a unique requestId, then waits for the
   * matching response or times out.
   *
   * @param {string} command - Command to execute
   * @param {object} [opts]
   * @param {number} [opts.timeout] - Override the default timeout for this command
   * @returns {Promise<{ output: string, exitCode: number, truncated?: boolean }>}
   */
  async execute(command, opts) {
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
      this.#pendingRequests.set(requestId, { resolve, reject, timer })

      // Send command to remote host
      try {
        this.#session.send('terminal', { command, requestId })
        this.#onLog(2, `Sent terminal command to ${this.#session.remotePodId}: ${command}`)
      } catch (err) {
        clearTimeout(timer)
        this.#pendingRequests.delete(requestId)
        reject(err)
      }
    })
  }

  // -- Resize ---------------------------------------------------------------

  /**
   * Send a resize event to the remote terminal (informational).
   * Does not wait for a response.
   *
   * @param {number} cols - Number of columns
   * @param {number} rows - Number of rows
   */
  sendResize(cols, rows) {
    this.#session.send('terminal', {
      resize: { cols, rows },
    })
  }

  // -- Response handling (private) ------------------------------------------

  /**
   * Handle an incoming terminal response from the remote host.
   * Matches by requestId and resolves the pending promise.
   *
   * @param {object} envelope - Session envelope with payload
   */
  #handleResponse(envelope) {
    const payload = envelope.payload || envelope
    const { requestId, output, exitCode, truncated } = payload

    if (!requestId) return

    const pending = this.#pendingRequests.get(requestId)
    if (!pending) return

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
   * Close the terminal client. Removes the handler from the session
   * and rejects all pending requests.
   */
  close() {
    // Reject all pending requests
    for (const [requestId, pending] of this.#pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(new Error('TerminalClient closed'))
    }
    this.#pendingRequests.clear()

    // Remove handler from session
    this.#session.removeHandler('terminal')

    // Clear listeners
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
      sessionId: this.#session.sessionId,
      localPodId: this.#session.localPodId,
      remotePodId: this.#session.remotePodId,
      pendingRequests: this.#pendingRequests.size,
      timeout: this.#timeout,
    }
  }
}
