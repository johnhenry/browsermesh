// Item 4 of #379: the browser entry (`@johnhenry/browsermesh-egress/browser`): a page's whole side of the wiring, in one import.
// Against a mock RTCPeerConnection (what is real here is the identity, the signalling dialect, the node and the error mapping);
// test/real-peer/browser-entry.test.mjs runs it over a real data channel to a real provider.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

if (!globalThis.crypto) globalThis.crypto = {}
if (!crypto.randomUUID) crypto.randomUUID = () => `uuid-${Math.random().toString(36).slice(2)}`
class MockRTCDataChannel { readyState = 'open'; close() {} }
class MockRTCPeerConnection {
  onicecandidate = null; ondatachannel = null; onconnectionstatechange = null; connectionState = 'new'; signalingState = 'stable'
  createDataChannel() { return new MockRTCDataChannel() }
  async createOffer() { return { type: 'offer', sdp: 'mock-offer-sdp' } }
  async setLocalDescription() {}
  close() {}
}
globalThis.RTCPeerConnection = MockRTCPeerConnection

const browser = await import('../src/browser.mjs')
const main = await import('../src/index.mjs')
const { createEgressNode } = browser
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const cleanups = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })
const quiet = () => ({ send() {}, onMessage() {} })
const made = async (options) => { const n = await createEgressNode({ signaling: quiet(), iceServers: [], ...options }); cleanups.push(() => n.close()); return n }
const code = (c) => (e) => e?.name === 'EgressError' && e.code === c
const POD = 'P'.repeat(43)

describe('what the entry exports', () => {
  it('the consumer side, the codes and the helpers, and nothing of the provider', () => {
    for (const name of ['createEgressNode', 'connectEgress', 'EgressError', 'EgressBackend', 'LINK_CODES', 'REFUSAL_CODES', 'CLOSE_REASONS', 'END_REASONS', 'BUDGET_NAMES', 'CONSUMER_LIMIT_DEFAULTS', 'KEEPALIVE_DEFAULTS', 'createAddressMemory', 'EGRESS_SCOPES']) assert.ok(browser[name] !== undefined, name)
    for (const name of ['createMeshEgress', 'EGRESS_LIMIT_DEFAULTS', 'DEFAULT_BLOCKED_PORTS', 'WIDE_ACKNOWLEDGEMENT']) assert.equal(browser[name], undefined, `${name} is the provider's`)
    assert.equal(browser.connectEgress, main.connectEgress, 'the same function as the main entry\'s')
    assert.equal(browser.EgressError, main.EgressError)
  })

  it('imports no node: module, no wsh and no provider file, however deep', async () => {
    const seen = new Set()
    const bad = []
    const visit = async (file) => {
      if (seen.has(file)) return
      seen.add(file)
      const text = await readFile(file, 'utf8')
      for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"\n]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const spec = m[1] ?? m[2]
        if (spec.startsWith('node:') || spec.startsWith('@johnhenry/wsh')) bad.push(`${path.relative(root, file)} imports ${spec}`)
        if (spec.startsWith('.')) await visit(path.resolve(path.dirname(file), spec))
      }
    }
    await visit(path.join(root, 'src/browser.mjs'))
    assert.deepEqual(bad, [])
    for (const provider of ['provider.mjs', 'node.mjs', 'node-exchange.mjs', 'limits.mjs']) assert.ok(![...seen].some((f) => f.endsWith(`/${provider}`)), `${provider} is reached`)
  })
})

describe('createEgressNode', () => {
  it('is a node with a pod id, the registry the provider-side grants name it by, and a service for protocols', async () => {
    const n = await made()
    assert.match(n.podId, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(n.node.podId, n.podId)
    assert.equal(typeof n.connect, 'function')
    assert.equal(typeof n.service.api.openProtocol, 'function')
    assert.ok(n.registry)
  })

  it('restores an identity it was given: the same pod id, from the key it exported', async () => {
    const first = await made()
    const privateKeyJwk = await first.identityManager.export(first.podId)
    const second = await made({ identity: { privateKeyJwk } })
    assert.equal(second.podId, first.podId)
    const third = await made()
    assert.notEqual(third.podId, first.podId)
  })

  it('refuses a signalling that is neither a URL nor a transport', async () => {
    for (const bad of [undefined, null, 5, {}, { send() {} }]) await assert.rejects(createEgressNode({ signaling: bad }), TypeError)
  })

  it('a signalling server that cannot be reached: signalling-unreachable, with the cause', async () => {
    const e = await createEgressNode({ signaling: 'ws://127.0.0.1:1/signaling' }).catch((x) => x)
    assert.ok(code('signalling-unreachable')(e), String(e))
    assert.ok(e.cause)
  })
})

describe('connect: what a page is told when the provider cannot be reached', () => {
  it('nobody answers at that pod id: provider-not-found', async () => {
    const n = await made({ answerTimeoutMs: 40 })
    await assert.rejects(n.connect(POD), code('provider-not-found'))
  })

  it('a signalling connection that fails while it is used: signalling-unreachable', async () => {
    const n = await made({ signaling: { send() { throw new Error('WebSocket is not open') }, onMessage() {} } })
    await assert.rejects(n.connect(POD), code('signalling-unreachable'))
  })

  it('a pod id is required, and a closed node says so', async () => {
    const n = await made()
    await assert.rejects(n.connect(''), TypeError)
    await n.close()
    await n.close()
    await assert.rejects(n.connect(POD), code('link-closed'))
  })
})
