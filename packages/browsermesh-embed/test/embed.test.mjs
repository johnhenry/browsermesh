import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { EmbeddedPod, ClawserEmbed } from '../src/index.mjs'
import { Pod } from '@johnhenry/browsermesh-pod'

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

  test('on/off/emit dispatch to registered listeners only while registered', () => {
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

  test('ClawserEmbed is a backward-compatible alias for EmbeddedPod', () => {
    assert.equal(ClawserEmbed, EmbeddedPod)
  })
})
