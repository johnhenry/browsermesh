// browsermesh-embed — standalone npm distribution of EmbeddedPod.
//
// EmbeddedPod: drop-in class for embedding an agent-backed workspace into
// any web app. Extends Pod with container rendering, messaging, and lazy
// agent init. `agent` is intentionally typed as a generic `object` below —
// this package doesn't depend on any specific agent implementation, only on
// the small `sendMessage`/`getEventLog`/`run` surface used in sendMessage().

import { Pod } from '@johnhenry/browsermesh-pod'

// ── EmbeddedPod ────────────────────────────────────────────────

/**
 * Embeddable agent-backed workspace pod.
 * Provides a minimal API for integrating an agent into external web apps.
 * Extends Pod for identity, discovery, and peer messaging.
 */
export class EmbeddedPod extends Pod {
  #config
  #agent = null
  #listeners = new Map()

  /**
   * @param {object} [config]
   * @param {string} [config.containerId] - DOM element ID to render into
   * @param {string} [config.provider] - Default LLM provider
   * @param {string} [config.model] - Default model
   * @param {object} [config.tools] - Tool configuration overrides
   * @param {object} [config.theme] - UI theme overrides
   * @param {object} [config.agent] - Pre-configured agent instance implementing
   *   sendMessage/getEventLog/run; typed as `object` since this package
   *   doesn't depend on any specific agent implementation
   */
  constructor(config = {}) {
    super()
    this.#config = {
      containerId: config.containerId || 'clawser',
      provider: config.provider || null,
      model: config.model || null,
      tools: config.tools || {},
      theme: config.theme || {},
      ...config,
    }
    if (config.agent) this.#agent = config.agent
  }

  get config() { return { ...this.#config } }

  /** Get the attached agent (if any). */
  get agent() { return this.#agent }

  /**
   * Attach or replace the agent instance.
   * @param {object} agent
   */
  setAgent(agent) { this.#agent = agent }

  /**
   * Send a message to the agent.
   * @param {string} text - User message
   * @param {object} [opts] - Options (streaming, model override, etc.)
   * @returns {Promise<{ content: string, toolCalls?: Array }>}
   */
  async sendMessage(text, opts = {}) {
    if (!this.#agent) {
      throw new Error('No agent attached. Call setAgent(agent) or pass { agent } in config before sending messages.')
    }

    // 1. Add the user message to agent history
    this.#agent.sendMessage(text, opts)

    // Snapshot event log length so we can extract tool_call events from this run
    const logBefore = this.#agent.getEventLog().query({ type: 'tool_call' }).length

    // 2. Run the agent (handles tool call loops internally)
    const result = await this.#agent.run()

    // 3. Extract tool calls that occurred during this run from the event log
    const allToolEvents = this.#agent.getEventLog().query({ type: 'tool_call' })
    const newToolEvents = allToolEvents.slice(logBefore)
    const toolCalls = newToolEvents.map(evt => ({
      id: evt.data.call_id,
      name: evt.data.name,
      arguments: evt.data.arguments,
    }))

    // 4. Return normalized response
    if (result.status === 1) {
      return { content: result.data, toolCalls, usage: result.usage, model: result.model }
    }

    // Error or blocked
    return { content: result.data || '', toolCalls, error: result.status < 0, usage: result.usage }
  }

  /**
   * Register an event listener.
   * @param {string} event
   * @param {Function} fn
   */
  on(event, fn) {
    const s = this.#listeners.get(event) || new Set()
    s.add(fn)
    this.#listeners.set(event, s)
  }

  /**
   * Remove an event listener.
   * @param {string} event
   * @param {Function} fn
   */
  off(event, fn) {
    this.#listeners.get(event)?.delete(fn)
  }

  /**
   * Emit an event to all registered listeners.
   * @param {string} event
   * @param {...any} args
   */
  emit(event, ...args) {
    for (const fn of this.#listeners.get(event) || []) fn(...args)
  }

  _onMessage(msg) {
    // Subclass hook — forward pod messages to the event bus
  }
}

/** Backward-compatible alias */
export const ClawserEmbed = EmbeddedPod
