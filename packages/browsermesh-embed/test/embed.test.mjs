import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { EmbeddedPod, ClawserEmbed } from '../src/index.mjs'
import { Pod } from '@johnhenry/browsermesh-pod'
import { installDomStub, makeElement } from './_dom-stub.mjs'

/** Fresh `document` stub with a `<div id="...">` container already present. */
function setupContainer(id = 'clawser') {
  const body = installDomStub()
  const container = makeElement('div')
  container.id = id
  body.appendChild(container)
  return container
}

/** Minimal real agent stand-in exercising the exact surface EmbeddedPod uses. */
class FakeAgent {
  #events = []
  #nextResult = { status: 1, data: 'ok', usage: { totalTokens: 3 }, model: 'test-model' }
  #lastText = null
  #lastOpts = null
  #onRun = null

  setNextResult(result) { this.#nextResult = result }

  sendMessage(text, opts = {}) {
    this.#lastText = text
    this.#lastOpts = opts
  }

  getEventLog() {
    const events = this.#events
    return {
      query({ type }) {
        return events.filter((e) => e.type === type)
      },
    }
  }

  emitToolCall(name, args, callId) {
    this.#events.push({ type: 'tool_call', data: { call_id: callId, name, arguments: args } })
  }

  /** Optional hook: emit a tool-call event as a side effect of run(), like a real agent would. */
  onRun(fn) { this.#onRun = fn }

  async run() {
    this.#onRun?.()
    return this.#nextResult
  }
}

describe('EmbeddedPod', () => {
  test('extends Pod', () => {
    const pod = new EmbeddedPod()
    assert.ok(pod instanceof Pod)
  })

  test('applies default config when none is given', () => {
    const pod = new EmbeddedPod()
    assert.equal(pod.config.containerId, 'clawser')
    assert.equal(pod.config.provider, null)
    assert.deepEqual(pod.config.tools, {})
  })

  test('config getter returns a defensive copy', () => {
    const pod = new EmbeddedPod({ containerId: 'x' })
    const c1 = pod.config
    c1.containerId = 'mutated'
    assert.equal(pod.config.containerId, 'x')
  })

  test('accepts an agent via constructor config', () => {
    const agent = new FakeAgent()
    const pod = new EmbeddedPod({ agent })
    assert.equal(pod.agent, agent)
  })

  test('setAgent replaces the attached agent', () => {
    const pod = new EmbeddedPod()
    assert.equal(pod.agent, null)
    const agent = new FakeAgent()
    pod.setAgent(agent)
    assert.equal(pod.agent, agent)
  })

  test('sendMessage throws when no agent is attached', async () => {
    const pod = new EmbeddedPod()
    await assert.rejects(() => pod.sendMessage('hi'), /No agent attached/)
  })

  test('sendMessage returns normalized content on success', async () => {
    const agent = new FakeAgent()
    const pod = new EmbeddedPod({ agent })
    const result = await pod.sendMessage('hello')
    assert.equal(result.content, 'ok')
    assert.equal(result.model, 'test-model')
    assert.deepEqual(result.toolCalls, [])
  })

  test('sendMessage surfaces only tool calls emitted during this run', async () => {
    const agent = new FakeAgent()
    agent.emitToolCall('search', { q: 'before' }, 'call-0')
    agent.onRun(() => agent.emitToolCall('search', { q: 'during' }, 'call-1'))
    const pod = new EmbeddedPod({ agent })
    const result = await pod.sendMessage('hello')
    assert.equal(result.toolCalls.length, 1)
    assert.equal(result.toolCalls[0].id, 'call-1')
    assert.equal(result.toolCalls[0].name, 'search')
    assert.deepEqual(result.toolCalls[0].arguments, { q: 'during' })
  })

  test('sendMessage marks errored/blocked results', async () => {
    const agent = new FakeAgent()
    agent.setNextResult({ status: -1, data: 'blocked', usage: {} })
    const pod = new EmbeddedPod({ agent })
    const result = await pod.sendMessage('hello')
    assert.equal(result.error, true)
    assert.equal(result.content, 'blocked')
  })

  test('on/off/emit dispatch to registered listeners only while registered (unified, inherited Pod bus)', () => {
    const pod = new EmbeddedPod()
    const calls = []
    const handler = (payload) => calls.push(payload)

    pod.on('greet', handler)
    pod.emit('greet', 'hi')
    assert.deepEqual(calls, ['hi'])

    pod.off('greet', handler)
    pod.emit('greet', 'again')
    assert.deepEqual(calls, ['hi'])
  })

  test('sendMessage fires a "response" event with the exact returned object', async () => {
    const agent = new FakeAgent()
    const pod = new EmbeddedPod({ agent })
    const received = []
    pod.on('response', (payload) => received.push(payload))

    const result = await pod.sendMessage('hello')

    assert.equal(received.length, 1)
    assert.equal(received[0], result)
  })

  test('ClawserEmbed is a backward-compatible alias for EmbeddedPod', () => {
    assert.equal(ClawserEmbed, EmbeddedPod)
  })
})

describe('EmbeddedPod widget DOM (mount)', () => {
  const cleanupDoc = () => { delete globalThis.document }

  test('mount() creates the expected structural DOM nodes under the container', () => {
    const container = setupContainer('clawser')
    try {
      const pod = new EmbeddedPod()
      pod.mount()

      assert.ok(pod.mounted)
      const shadow = container.shadowRoot
      assert.ok(shadow, 'container should have a shadowRoot')

      const wrap = shadow.children.find((c) => c.classList.contains('bm-embed'))
      assert.ok(wrap, 'expected a .bm-embed wrapper')

      const statusEl = wrap.children.find((c) => c.classList.contains('bm-status'))
      const logEl = wrap.children.find((c) => c.classList.contains('bm-log'))
      const formEl = wrap.children.find((c) => c.tagName === 'FORM')
      assert.ok(statusEl, 'expected a status element')
      assert.ok(logEl, 'expected a log element')
      assert.ok(formEl, 'expected a form element')

      const inputEl = formEl.children.find((c) => c.tagName === 'INPUT')
      const submitEl = formEl.children.find((c) => c.tagName === 'BUTTON')
      assert.ok(inputEl, 'expected an input element')
      assert.ok(submitEl, 'expected a submit button')
    } finally {
      cleanupDoc()
    }
  })

  test('mount() auto-runs from the constructor when the container already exists', () => {
    const container = setupContainer('clawser')
    try {
      const pod = new EmbeddedPod()
      assert.ok(pod.mounted)
      assert.ok(container.shadowRoot)
    } finally {
      cleanupDoc()
    }
  })

  test('mount() is a no-op if the container does not exist (no throw)', () => {
    installDomStub()
    try {
      assert.doesNotThrow(() => {
        const pod = new EmbeddedPod()
        pod.mount()
        assert.equal(pod.mounted, false)
      })
    } finally {
      cleanupDoc()
    }
  })

  test('mount() is idempotent — calling it twice does not rebuild the DOM', () => {
    const container = setupContainer('clawser')
    try {
      const pod = new EmbeddedPod()
      pod.mount()
      const shadowFirst = container.shadowRoot
      const childCountFirst = shadowFirst.children.length

      pod.mount()

      assert.equal(container.shadowRoot, shadowFirst, 'attachShadow should not be called again')
      assert.equal(container.shadowRoot.children.length, childCountFirst)
    } finally {
      cleanupDoc()
    }
  })

  test('status line reflects peers.size after real peer:found/peer:lost events from a boot()', async () => {
    const container = setupContainer('clawser')
    try {
      const pod = new EmbeddedPod()
      const statusEl = container.shadowRoot.children.find((c) => c.classList.contains('bm-embed'))
        .children.find((c) => c.classList.contains('bm-status'))

      assert.match(statusEl.textContent, /0 peers/)

      // Minimal fake DiscoveryAdapter satisfying exactly the contract Pod's
      // #peerDiscovery() calls (onPeerDiscovered/onPeerLost/onMessage/start) —
      // this drives Pod's *real* #addPeer()/#removePeer() (and therefore its
      // real `peers` Map and real 'peer:found'/'peer:lost' emits), rather than
      // faking the event payload directly, since EmbeddedPod's status line is
      // grounded in `this.peers.size`, not the event payload.
      let onPeerFound, onPeerLost
      const discovery = {
        onPeerDiscovered(cb) { onPeerFound = cb },
        onPeerLost(cb) { onPeerLost = cb },
        onMessage() {},
        start: async () => {},
        stop: async () => {},
      }

      await pod.boot({ discovery })
      assert.match(statusEl.textContent, /ready/)
      assert.match(statusEl.textContent, /0 peers/)

      onPeerFound({ podId: 'peer-1', kind: 'window' })
      assert.equal(pod.peers.size, 1)
      assert.match(statusEl.textContent, /1 peer\b/)

      onPeerFound({ podId: 'peer-2', kind: 'window' })
      assert.match(statusEl.textContent, /2 peers/)

      onPeerLost({ podId: 'peer-1' })
      assert.equal(pod.peers.size, 1)
      assert.match(statusEl.textContent, /1 peer\b/)
    } finally {
      cleanupDoc()
    }
  })

  test('submitting the form calls sendMessage() and appends user + agent entries to the log', async () => {
    const container = setupContainer('clawser')
    try {
      const agent = new FakeAgent()
      const pod = new EmbeddedPod({ agent })
      const wrap = container.shadowRoot.children.find((c) => c.classList.contains('bm-embed'))
      const logEl = wrap.children.find((c) => c.classList.contains('bm-log'))
      const formEl = wrap.children.find((c) => c.tagName === 'FORM')
      const inputEl = formEl.children.find((c) => c.tagName === 'INPUT')

      inputEl.value = 'hello there'

      const responseReceived = new Promise((resolve) => pod.on('response', resolve))
      formEl.dispatchEvent({ type: 'submit' })
      await responseReceived

      const userEntry = logEl.children.find((c) => c.classList.contains('bm-entry-user'))
      const agentEntry = logEl.children.find((c) => c.classList.contains('bm-entry-agent'))
      assert.ok(userEntry, 'expected a user entry in the log')
      assert.equal(userEntry.textContent, 'hello there')
      assert.ok(agentEntry, 'expected an agent entry in the log')
      assert.equal(agentEntry.textContent, 'ok')

      // pending "thinking…" entry should have been removed once the response landed
      const pendingEntry = logEl.children.find((c) => c.classList.contains('bm-entry-pending'))
      assert.equal(pendingEntry, undefined)
    } finally {
      cleanupDoc()
    }
  })

  test('submitting the form before setAgent() renders an inline error entry, not an uncaught rejection', async () => {
    const container = setupContainer('clawser')
    try {
      const pod = new EmbeddedPod() // no agent attached
      const wrap = container.shadowRoot.children.find((c) => c.classList.contains('bm-embed'))
      const logEl = wrap.children.find((c) => c.classList.contains('bm-log'))
      const formEl = wrap.children.find((c) => c.tagName === 'FORM')
      const inputEl = formEl.children.find((c) => c.tagName === 'INPUT')

      inputEl.value = 'hello'
      formEl.dispatchEvent({ type: 'submit' })

      // Give the rejected sendMessage() promise's .catch() a turn to run.
      await new Promise((resolve) => setImmediate(resolve))

      const errorEntry = logEl.children.find((c) => c.classList.contains('bm-entry-error'))
      assert.ok(errorEntry, 'expected an inline error entry')
      assert.match(errorEntry.textContent, /No agent attached/)
    } finally {
      cleanupDoc()
    }
  })
})
