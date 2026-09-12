// browsermesh-embed — standalone npm distribution of EmbeddedPod.
//
// EmbeddedPod: drop-in class for embedding an agent-backed workspace into
// any web app. Extends Pod with container rendering, messaging, and lazy
// agent init. `agent` is intentionally typed as a generic `object` below —
// this package doesn't depend on any specific agent implementation, only on
// the small `sendMessage`/`getEventLog`/`run` surface used in sendMessage().

import { Pod } from '@johnhenry/browsermesh-pod'
import { buildSkeleton, setStatus, appendEntry, setInputDisabled } from './dom.mjs'

// ── EmbeddedPod ────────────────────────────────────────────────

/**
 * Embeddable agent-backed workspace pod.
 * Provides a minimal API for integrating an agent into external web apps.
 * Extends Pod for identity, discovery, and peer messaging.
 *
 * `on`/`off` are inherited directly from `Pod` — do not shadow them here.
 * `Pod`'s internal lifecycle events (`'ready'`, `'peer:found'`, `'peer:lost'`,
 * `'message'`, `'error'`, `'shutdown'`) are dispatched via `Pod`'s protected
 * `_emit()`, which writes into `Pod`'s own private listener map. A subclass
 * declaring its own private `#listeners`/`on`/`off`/`emit` would shadow that
 * map (JS private fields aren't polymorphic) and silently break every
 * lifecycle event — that was a real, since-fixed bug here.
 */
export class EmbeddedPod extends Pod {
  #config
  #agent = null
  #mounted = false
  #shadowRoot = null

  /**
   * @param {object} [config]
   * @param {string} [config.containerId] - DOM element ID to render into
   * @param {string} [config.provider] - Default LLM provider
   * @param {string} [config.model] - Default model
   * @param {object} [config.tools] - Tool configuration overrides
   * @param {object} [config.theme] - UI theme overrides (--bm-accent/--bm-bg/--bm-fg)
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

    // Auto-mount only if the container already exists at construction time
    // (matches injected-pod.mjs's defensiveness: no throw if `document`
    // doesn't exist, e.g. in Node/tests). SPA hosts that create the
    // container after constructing EmbeddedPod should call mount() explicitly.
    if (globalThis.document?.getElementById?.(this.#config.containerId)) {
      this.mount()
    }
  }

  get config() { return { ...this.#config } }

  /** Get the attached agent (if any). */
  get agent() { return this.#agent }

  /** @returns {boolean} Whether mount() has built the widget DOM. */
  get mounted() { return this.#mounted }

  /**
   * Attach or replace the agent instance.
   * @param {object} agent
   */
  setAgent(agent) { this.#agent = agent }

  /**
   * Mount the widget into `config.containerId`'s element. Idempotent —
   * a no-op if already mounted. Fails gracefully (no throw) if `document`
   * doesn't exist or the container element isn't found yet; callers in SPA
   * contexts where the container is created after construction should call
   * this explicitly once it exists.
   */
  mount() {
    if (this.#mounted) return

    const doc = globalThis.document
    if (!doc?.getElementById) return
    const container = doc.getElementById(this.#config.containerId)
    if (!container || typeof container.attachShadow !== 'function') return

    const shadow = container.attachShadow({ mode: 'open' })
    const { statusEl, logEl, formEl, inputEl, submitEl } = buildSkeleton(doc, shadow, this.#config)
    this.#shadowRoot = shadow
    this.#mounted = true

    // Reactive status line — driven off Pod's own state/role/peers, nothing invented.
    const updateStatus = () => {
      setStatus(statusEl, { state: this.state, role: this.role, peerCount: this.peers.size })
    }
    this.on('ready', updateStatus)
    this.on('peer:found', updateStatus)
    this.on('peer:lost', updateStatus)
    updateStatus()

    // Message log, driven by the 'response' event (so any sendMessage() call
    // — from the form below or from host code directly — shows up here) plus
    // a local pending-entry handle for the "thinking…" state.
    let pendingEntry = null
    this.on('response', (result) => {
      pendingEntry?.remove?.()
      pendingEntry = null
      appendEntry(doc, logEl, {
        role: 'agent',
        content: result?.content ?? '',
        toolCalls: result?.toolCalls,
        error: result?.error,
      })
      setInputDisabled(inputEl, submitEl, false)
    })

    formEl.addEventListener('submit', (event) => {
      event.preventDefault?.()
      const text = (inputEl.value ?? '').trim()
      if (!text) return

      appendEntry(doc, logEl, { role: 'user', content: text })
      inputEl.value = ''
      setInputDisabled(inputEl, submitEl, true)
      pendingEntry = appendEntry(doc, logEl, { role: 'pending', content: 'Thinking…' })

      this.sendMessage(text).catch((err) => {
        // sendMessage() rejects (e.g. no agent attached) before it can emit
        // 'response' — render that inline instead of an uncaught rejection.
        pendingEntry?.remove?.()
        pendingEntry = null
        appendEntry(doc, logEl, { role: 'error', content: err?.message || String(err), error: true })
        setInputDisabled(inputEl, submitEl, false)
      })
    })
  }

  /**
   * Send a message to the agent. Emits a `'response'` event with the
   * resolved result once it's ready (matches the README's documented
   * `pod.on('response', ...)` pattern).
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
    const runResult = await this.#agent.run()

    // 3. Extract tool calls that occurred during this run from the event log
    const allToolEvents = this.#agent.getEventLog().query({ type: 'tool_call' })
    const newToolEvents = allToolEvents.slice(logBefore)
    const toolCalls = newToolEvents.map(evt => ({
      id: evt.data.call_id,
      name: evt.data.name,
      arguments: evt.data.arguments,
    }))

    // 4. Normalize response
    const response = runResult.status === 1
      ? { content: runResult.data, toolCalls, usage: runResult.usage, model: runResult.model }
      : { content: runResult.data || '', toolCalls, error: runResult.status < 0, usage: runResult.usage }

    this.emit('response', response)
    return response
  }

  /**
   * Emit an event to all registered listeners, via Pod's protected
   * `_emit()` — the single shared bus that `on()`/`off()` (inherited
   * directly from Pod) populate. Single-argument `data` signature, matching
   * `Pod._emit`'s shape (and `InjectedPod.emit()`'s, the other precedent
   * in this family for a public emit() over Pod's protected `_emit()`).
   * @param {string} event
   * @param {*} [data]
   */
  emit(event, data) {
    this._emit(event, data)
  }

  _onMessage(msg) {
    // Subclass hook — forward pod messages to the event bus
  }
}

/** Backward-compatible alias */
export const ClawserEmbed = EmbeddedPod
