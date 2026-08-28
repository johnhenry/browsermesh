/**
 * clawser-peer-agent.js -- Remote agent interaction over peer sessions.
 *
 * Allows one peer to chat with, invoke tools on, and query memories of
 * another peer's AI agent. AgentHost serves the local ClawserAgent to
 * remote peers, while AgentClient provides a promise-based interface for
 * interacting with a remote peer's agent. Built on top of PeerSession's
 * service handler system using the 'agent' service type.
 *
 * Dependencies are injected (PeerSession, agent interface).
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-peer-agent.test.mjs
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const AGENT_DEFAULTS = Object.freeze({
  timeout: 60000,  // 60s -- agent calls can be slow
})

export const AGENT_ACTIONS = Object.freeze({
  CHAT: 'chat',
  TOOL: 'tool',
  MEMORIES: 'memories',
})

export const AGENT_CAPABILITIES = Object.freeze({
  CHAT: 'agent:chat',
  TOOLS: 'agent:tools',
  MEMORY: 'agent:memory',
})

// ---------------------------------------------------------------------------
// Internal -- map actions to required capabilities
// ---------------------------------------------------------------------------

const ACTION_CAPABILITY = Object.freeze({
  [AGENT_ACTIONS.CHAT]: AGENT_CAPABILITIES.CHAT,
  [AGENT_ACTIONS.TOOL]: AGENT_CAPABILITIES.TOOLS,
  [AGENT_ACTIONS.MEMORIES]: AGENT_CAPABILITIES.MEMORY,
})

// ---------------------------------------------------------------------------
// AgentHost
// ---------------------------------------------------------------------------

/**
 * Serves agent operations from the local ClawserAgent to remote peers.
 *
 * Registers a handler on the PeerSession for the 'agent' service type.
 * Incoming requests are validated against capability requirements before
 * execution. The remote peer must hold the appropriate capability on the
 * session (agent:chat, agent:tools, agent:memory).
 *
 * When a ChannelGateway is provided, CHAT actions are routed through
 * the gateway for unified queuing, event recording, and UI mirroring.
 */
export class AgentHost {
  /** @type {object} PeerSession */
  #session

  /**
   * @type {object} Agent interface (duck-typed)
   *   async run(message) -> { response: string, usage?: object }
   *   async executeTool(name, args) -> { success, output, error? }
   *   searchMemories(query) -> MemoryEntry[]
   */
  #agent

  /** @type {import('./clawser-gateway.js').ChannelGateway|null} */
  #gateway

  /** @type {object|null} { recordUsage(peerId, usage) } */
  #costTracker

  /** @type {Function} */
  #onLog

  /** @type {number} requests handled */
  #requestCount = 0

  /**
   * @param {object} opts
   * @param {object} opts.session - PeerSession instance
   * @param {object} opts.agent - Agent interface with run/executeTool/searchMemories
   * @param {import('./clawser-gateway.js').ChannelGateway} [opts.gateway] - Channel gateway for unified routing
   * @param {object} [opts.costTracker] - Cost tracker with recordUsage(peerId, usage)
   * @param {Function} [opts.onLog] - Logging callback
   */
  constructor({ session, agent, costTracker, gateway, onLog }) {
    if (!session) {
      throw new Error('session is required')
    }
    if (!agent || typeof agent.run !== 'function') {
      throw new Error('agent with run() method is required')
    }

    this.#session = session
    this.#agent = agent
    this.#gateway = gateway || null
    this.#costTracker = costTracker || null
    this.#onLog = onLog || (() => {})

    // Register handler on session for 'agent' service type
    this.#session.registerHandler('agent', (envelope) => this.#handleRequest(envelope))
  }

  /** Set or replace the gateway reference. */
  setGateway(gateway) { this.#gateway = gateway }

  // -- Request handling (private) -------------------------------------------

  /**
   * Handle an incoming agent request.
   *
   * 1. Validates the action
   * 2. Checks the required capability on the session
   * 3. Dispatches to the appropriate agent method
   * 4. Tracks cost attribution if costTracker is configured
   * 5. Sends the response back via session
   *
   * @param {object} envelope - Session envelope with payload
   */
  async #handleRequest(envelope) {
    const payload = envelope.payload || envelope
    const { action, requestId } = payload

    // Build base response
    const response = {
      requestId: requestId || null,
      action: action || null,
      success: false,
    }

    try {
      // 1. Validate action
      if (!action || !Object.values(AGENT_ACTIONS).includes(action)) {
        response.error = `Unknown action: ${action}`
        this.#session.send('agent', response)
        return
      }

      // 2. Check capability
      const requiredCap = ACTION_CAPABILITY[action]
      if (requiredCap) {
        this.#session.requireCapability(requiredCap)
      }

      // 3. Dispatch to the appropriate agent method
      switch (action) {
        case AGENT_ACTIONS.CHAT: {
          const { message } = payload
          if (!message || typeof message !== 'string') {
            response.error = 'message must be a non-empty string'
            this.#session.send('agent', response)
            return
          }

          this.#onLog(2, `Agent chat request from ${this.#session.remotePodId}`)

          if (this.#gateway) {
            // Route through gateway for unified queuing, event recording, and UI mirroring
            const channelId = `mesh:${this.#session.remotePodId}`
            const gatewayResponse = await this.#gateway.ingest({
              id: `peer_${requestId || Date.now()}`,
              channel: 'mesh',
              channelId: this.#session.remotePodId,
              sender: {
                id: this.#session.remotePodId,
                name: this.#session.remotePodId,
                username: null,
              },
              content: message,
              attachments: [],
              replyTo: null,
              timestamp: Date.now(),
            }, channelId)
            this.#requestCount++

            response.success = true
            response.result = {
              response: gatewayResponse,
            }
          } else {
            // Direct agent call (original behavior)
            const chatResult = await this.#agent.run(message)
            this.#requestCount++

            response.success = true
            response.result = {
              response: chatResult.response,
            }
            if (chatResult.usage) {
              response.result.usage = chatResult.usage
            }

            // Track cost attribution
            if (this.#costTracker && chatResult.usage) {
              try {
                this.#costTracker.recordUsage(this.#session.remotePodId, chatResult.usage)
              } catch {
                /* cost tracking errors do not propagate */
              }
            }
          }
          break
        }

        case AGENT_ACTIONS.TOOL: {
          const { name, args } = payload
          if (!name || typeof name !== 'string') {
            response.error = 'tool name must be a non-empty string'
            this.#session.send('agent', response)
            return
          }

          this.#onLog(2, `Agent tool request from ${this.#session.remotePodId}: ${name}`)
          const toolResult = await this.#agent.executeTool(name, args || {})
          this.#requestCount++

          response.success = true
          response.result = {
            success: toolResult.success,
            output: toolResult.output,
          }
          if (toolResult.error) {
            response.result.error = toolResult.error
          }
          break
        }

        case AGENT_ACTIONS.MEMORIES: {
          const { query } = payload
          if (!query || typeof query !== 'string') {
            response.error = 'query must be a non-empty string'
            this.#session.send('agent', response)
            return
          }

          this.#onLog(2, `Agent memory search from ${this.#session.remotePodId}: ${query}`)
          const memories = this.#agent.searchMemories(query)
          this.#requestCount++

          response.success = true
          response.result = memories
          break
        }
      }
    } catch (err) {
      response.error = err.message
      this.#onLog(0, `Agent request error (${action}): ${err.message}`)
    }

    // Send response back
    this.#session.send('agent', response)
  }

  // -- Lifecycle ------------------------------------------------------------

  /**
   * Close the agent host. Removes the handler from the session.
   */
  close() {
    this.#session.removeHandler('agent')
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
      requestCount: this.#requestCount,
      hasCostTracker: this.#costTracker !== null,
    }
  }
}

// ---------------------------------------------------------------------------
// AgentClient
// ---------------------------------------------------------------------------

/**
 * Client-side interface for interacting with a remote peer's agent.
 *
 * Sends agent requests via the PeerSession and waits for responses
 * matched by requestId. Supports configurable timeout per request and
 * provides promise-based methods for chat, tool execution, and memory
 * search.
 */
export class AgentClient {
  /** @type {object} PeerSession */
  #session

  /** @type {Map<string, { resolve: Function, reject: Function, timer: * }>} */
  #pendingRequests = new Map()

  /** @type {number} default timeout in ms */
  #timeout

  /** @type {Function} */
  #onLog

  /**
   * @param {object} opts
   * @param {object} opts.session - PeerSession instance
   * @param {number} [opts.timeout=60000] - Default timeout for requests in ms
   * @param {Function} [opts.onLog] - Logging callback
   */
  constructor({ session, timeout, onLog }) {
    if (!session) {
      throw new Error('session is required')
    }

    this.#session = session
    this.#timeout = timeout ?? AGENT_DEFAULTS.timeout
    this.#onLog = onLog || (() => {})

    // Register handler on session for 'agent' response messages
    this.#session.registerHandler('agent', (envelope) => this.#handleResponse(envelope))
  }

  // -- Agent operations -----------------------------------------------------

  /**
   * Send a chat message to the remote peer's agent.
   *
   * @param {string} message - Message to send to the agent
   * @returns {Promise<{ response: string, usage?: object }>}
   */
  async chat(message) {
    if (!message || typeof message !== 'string') {
      throw new Error('message must be a non-empty string')
    }

    const response = await this.#request({
      action: AGENT_ACTIONS.CHAT,
      message,
    })
    return response.result
  }

  /**
   * Execute a tool on the remote peer's agent.
   *
   * @param {string} toolName - Name of the tool to execute
   * @param {object} [args={}] - Tool arguments
   * @returns {Promise<{ success: boolean, output: *, error?: string }>}
   */
  async runTool(toolName, args) {
    if (!toolName || typeof toolName !== 'string') {
      throw new Error('toolName must be a non-empty string')
    }

    const response = await this.#request({
      action: AGENT_ACTIONS.TOOL,
      name: toolName,
      args: args || {},
    })
    return response.result
  }

  /**
   * Search memories on the remote peer's agent.
   *
   * @param {string} query - Search query
   * @returns {Promise<MemoryEntry[]>}
   */
  async searchMemories(query) {
    if (!query || typeof query !== 'string') {
      throw new Error('query must be a non-empty string')
    }

    const response = await this.#request({
      action: AGENT_ACTIONS.MEMORIES,
      query,
    })
    return response.result
  }

  // -- Internal request handling --------------------------------------------

  /**
   * Send an agent request and wait for the matching response.
   *
   * Creates a unique requestId, sends the request via the session,
   * and returns a promise that resolves when the response arrives
   * or rejects on timeout.
   *
   * @param {object} payload - Request payload (must include action)
   * @returns {Promise<{ requestId, action, success, result?, error? }>}
   */
  async #request(payload) {
    const requestId = crypto.randomUUID()
    const timeoutMs = this.#timeout

    return new Promise((resolve, reject) => {
      // Set up timeout
      const timer = setTimeout(() => {
        const pending = this.#pendingRequests.get(requestId)
        if (pending) {
          this.#pendingRequests.delete(requestId)
          const err = new Error(`Agent request timed out after ${timeoutMs}ms`)
          err.code = 'AGENT_TIMEOUT'
          reject(err)
        }
      }, timeoutMs)

      // Register pending request
      this.#pendingRequests.set(requestId, { resolve, reject, timer })

      // Build and send request
      const message = { ...payload, requestId }

      try {
        this.#session.send('agent', message)
        this.#onLog(2, `Sent agent ${payload.action} request to ${this.#session.remotePodId}`)
      } catch (err) {
        clearTimeout(timer)
        this.#pendingRequests.delete(requestId)
        reject(err)
      }
    })
  }

  // -- Response handling (private) ------------------------------------------

  /**
   * Handle an incoming agent response from the remote host.
   * Matches by requestId and resolves or rejects the pending promise.
   *
   * @param {object} envelope - Session envelope with payload
   */
  #handleResponse(envelope) {
    const payload = envelope.payload || envelope
    const { requestId } = payload

    if (!requestId) return

    const pending = this.#pendingRequests.get(requestId)
    if (!pending) return

    // Clean up
    clearTimeout(pending.timer)
    this.#pendingRequests.delete(requestId)

    // Check for errors
    if (payload.error) {
      const err = new Error(payload.error)
      err.code = 'AGENT_REMOTE_ERROR'
      pending.reject(err)
      return
    }

    // Resolve with the full response
    pending.resolve(payload)
  }

  // -- Lifecycle ------------------------------------------------------------

  /**
   * Close the agent client. Removes the handler from the session
   * and rejects all pending requests.
   */
  close() {
    // Reject all pending requests
    for (const [requestId, pending] of this.#pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(new Error('AgentClient closed'))
    }
    this.#pendingRequests.clear()

    // Remove handler from session
    this.#session.removeHandler('agent')
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

// ---------------------------------------------------------------------------
// Factory helper
// ---------------------------------------------------------------------------

/**
 * Create an AgentHost wired to a ChannelGateway for unified routing.
 *
 * Registers a lightweight mesh plugin on the gateway so outbound responses
 * route back through the session transport. Returns the AgentHost instance.
 *
 * @param {object} session - PeerSession instance
 * @param {object} agent - Agent with run/executeTool/searchMemories
 * @param {import('./clawser-gateway.js').ChannelGateway} gateway - Channel gateway
 * @param {Function} [onLog] - Logging callback
 * @returns {AgentHost}
 */
export function bridgePeerAgent(session, agent, gateway, onLog) {
  const channelId = `mesh:${session.remotePodId}`

  // Register a lightweight plugin on the gateway for this peer
  // so gateway.respond() can send outbound messages via the session.
  const plugin = {
    running: true,
    start() { this.running = true },
    stop() { this.running = false },
    onMessage() {}, // Inbound handled by AgentHost, not plugin polling
    async sendMessage(text) {
      try {
        session.send('agent', {
          success: true,
          result: { response: text },
        })
        return true
      } catch {
        return false
      }
    },
  }

  gateway.register(channelId, plugin, { scope: 'shared' })

  return new AgentHost({ session, agent, gateway, onLog })
}
