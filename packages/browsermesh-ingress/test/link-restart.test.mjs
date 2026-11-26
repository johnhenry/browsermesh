// A pod that stops and starts again, many times, against the one ingress that keeps running: every request during and after
// each cycle is answered whole, whichever way the old link's end reaches the ingress (before the new link, after it, or not
// at all until the new link replaces it). Two pods taking turns do not disturb each other.
//
// In-process, on the in-memory bus: the ingress is never restarted, the pods' services are (a new service on the same node
// is a new link: a new session id in its hello).
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { attachService, createMeshProtocolService } from '@johnhenry/browsermesh-apps'
import { createMeshIngress, serveHttpOnMesh } from '../src/index.mjs'
import { REASON_HEADER } from '../src/errors.mjs'
import { threePods, grantHttp, until } from './helpers/mesh.mjs'

const cleanups = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })

/** A pod that can be stopped and started again on the same node: each start is a new protocol service and a new `serveHttpOnMesh`. */
function restartable(node, ingressId, label) {
  const pod = { generation: 0, service: null, served: null, held: [] }
  pod.start = () => {
    pod.generation += 1
    const generation = pod.generation
    pod.service = attachService(node, undefined, createMeshProtocolService())
    pod.served = serveHttpOnMesh(pod.service, async (request) => {
      const path = new URL(request.url).pathname
      if (path === '/big') return new Response(new Uint8Array(300_000).fill(generation % 251))
      return new Response(`${label} gen ${generation}`)
    }, { allowFrom: [ingressId] })
  }
  pod.stop = () => { pod.served?.stop(); pod.service?.teardown(); pod.served = null; pod.service = null }
  // Hold back what this pod sends to say its link ended, to deliver it at a moment the test chooses.
  const send = node.sendTo.bind(node)
  pod.holding = false
  node.sendTo = (to, data) => (pod.holding && data?.k === 'close' ? (pod.held.push([to, data]), Promise.resolve()) : send(to, data))
  pod.release = async () => { pod.holding = false; for (const [to, data] of pod.held.splice(0)) await send(to, data) }
  pod.start()
  return pod
}

async function rig() {
  const pods = await threePods()
  cleanups.push(() => pods.teardown())
  // threePods attached services of its own to the provider and the stranger; these tests restart their own.
  pods.p.teardown()
  pods.s.teardown()
  const a = restartable(pods.provider, pods.ingress.podId, 'a')
  const b = restartable(pods.stranger, pods.ingress.podId, 'b')
  cleanups.push(() => { a.stop(); b.stop() })
  pods.provider.registry.grantCapabilities(pods.ingress.podId, ['protocol:http:open'])
  pods.stranger.registry.grantCapabilities(pods.ingress.podId, ['protocol:http:open'])
  const peers = { 'a.example.test': pods.provider.podId, 'b.example.test': pods.stranger.podId }
  const mesh = createMeshIngress({ service: pods.i, limits: { openTimeoutMs: 250 }, resolve: (request) => { const peer = peers[new URL(request.url).host]; return peer ? { peer } : null } })
  cleanups.push(() => mesh.close())
  const get = async (host, path = '/') => {
    const res = await mesh.handle(new Request(`http://${host}${path}`))
    const bytes = new Uint8Array(await res.arrayBuffer())
    return { status: res.status, reason: res.headers.get(REASON_HEADER), bytes, text: new TextDecoder().decode(bytes.byteLength < 100 ? bytes : new Uint8Array(0)) }
  }
  return { ...pods, a, b, mesh, get }
}

describe('a pod stops and starts again against a running ingress', () => {
  it('twenty cycles of one identity, a request during and after each, every answer whole', async () => {
    const t = await rig()
    for (let cycle = 1; cycle <= 20; cycle++) {
      const during = await t.get('a.example.test')
      assert.deepEqual([during.status, during.text], [200, `a gen ${cycle}`], `during cycle ${cycle}`)
      const big = await t.get('a.example.test', '/big')
      assert.equal(big.status, 200, `big during cycle ${cycle}: ${big.reason}`)
      assert.equal(big.bytes.byteLength, 300_000)
      t.a.stop()
      t.a.start()
      const after = await t.get('a.example.test')
      assert.deepEqual([after.status, after.text], [200, `a gen ${cycle + 1}`], `after cycle ${cycle}`)
    }
    assert.equal(t.mesh.stats().failed, 0)
    assert.equal(t.mesh.stats().providers, 1)
  })

  it('a start while the old link\'s close is still in flight, and the close arriving afterwards, leave the new link answering', async () => {
    const t = await rig()
    for (let cycle = 1; cycle <= 10; cycle++) {
      assert.equal((await t.get('a.example.test')).text, `a gen ${cycle}`)
      t.a.holding = true
      t.a.stop() // its close is held back: the ingress still has the old link
      t.a.start()
      await t.a.service.api.channel.open(t.ingress.podId) // the new page dials the ingress: its hello is what tells the ingress
      const during = await t.get('a.example.test')
      assert.deepEqual([during.status, during.text], [200, `a gen ${cycle + 1}`], `with the old close in flight, cycle ${cycle}`)
      await t.a.release() // the old link's close arrives late
      const big = await t.get('a.example.test', '/big')
      assert.equal(big.status, 200, `after the late close, cycle ${cycle}: ${big.reason}`)
      assert.equal(big.bytes.byteLength, 300_000)
      assert.equal((await t.get('a.example.test')).text, `a gen ${cycle + 1}`)
    }
  })

  it('two pods taking turns: one restarting never disturbs the answers of the other', async () => {
    const t = await rig()
    for (let cycle = 1; cycle <= 10; cycle++) {
      const [x, y] = cycle % 2 ? [t.a, t.b] : [t.b, t.a]
      const hostOf = (pod) => (pod === t.a ? 'a.example.test' : 'b.example.test')
      const label = (pod) => (pod === t.a ? 'a' : 'b')
      x.stop()
      const meanwhile = await t.get(hostOf(y))
      assert.deepEqual([meanwhile.status, meanwhile.text], [200, `${label(y)} gen ${y.generation}`])
      x.start()
      const back = await t.get(hostOf(x))
      assert.deepEqual([back.status, back.text], [200, `${label(x)} gen ${x.generation}`], `cycle ${cycle}`)
      const other = await t.get(hostOf(y), '/big')
      assert.equal(other.status, 200)
      assert.equal(other.bytes.byteLength, 300_000)
    }
  })

  it('a pod that is stopped answers with a named failure, not a hang, and answers again when it starts', async () => {
    const t = await rig()
    assert.equal((await t.get('a.example.test')).status, 200)
    t.a.stop()
    const gone = await t.get('a.example.test')
    assert.ok(gone.status >= 502, `status ${gone.status}`)
    assert.ok(gone.reason, 'the failure is named')
    t.a.start()
    assert.equal((await t.get('a.example.test')).text, `a gen ${t.a.generation}`)
  })
})
