/**
 * Within one `pod-host` resource, a pod belongs to the requester that
 * spawned it: send, exec, snapshot, restore and drain on it need ownership or
 * an explicit grant on the pod itself (`pod-host/<name>:<verb>`), not merely
 * the verb on the host resource. `status` of someone else's pod still works
 * but shows no env values or input, and registers no event interest.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/pod-host-tenancy.test.mjs
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  IdentityWallet,
  MeshIdentityManager,
  MeshPeerManager,
  TrustGraph,
  MeshACL,
} from '@johnhenry/browsermesh-core'
import { InMemoryPodHostDriver, POD_LANE, POD_HOST_ERROR } from '@johnhenry/browsermesh-pod'

import { PeerRegistry } from '../src/peer-registry.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { createPodHostService, createPodHostClient, DEFAULT_POD_HOST_RESOURCE } from '../src/pod-host-service.mjs'

const RESOURCE = DEFAULT_POD_HOST_RESOURCE
const ALL_SCOPES = ['spawn', 'status', 'send', 'exec', 'snapshot', 'restore', 'drain', 'list'].map((v) => `${RESOURCE}:${v}`)

async function createPeer(label) {
  const identityManager = new MeshIdentityManager({})
  const wallet = new IdentityWallet({ identityManager })
  const { podId } = await wallet.createIdentity(label)
  const registry = new PeerRegistry({
    localPodId: podId,
    peerManager: new MeshPeerManager({}),
    trustGraph: new TrustGraph(),
    acl: new MeshACL({ owner: podId }),
  })
  return { podId, wallet, registry }
}

function wireMesh(peers) {
  const listeners = new Map()
  const nodes = new Map()
  for (const peer of peers) {
    listeners.set(peer.podId, new Set())
    nodes.set(peer.podId, {
      podId: peer.podId,
      wallet: peer.wallet,
      registry: peer.registry,
      onIncomingData(cb) {
        listeners.get(peer.podId).add(cb)
        return () => listeners.get(peer.podId).delete(cb)
      },
      async sendTo(pubKey, data) {
        const target = listeners.get(pubKey)
        if (!target) throw new Error(`no such peer: ${pubKey}`)
        queueMicrotask(() => { for (const cb of [...target]) cb(peer.podId, data) })
      },
    })
  }
  return nodes
}

const SPEC = (name) => ({ name, lane: POD_LANE.NODE, run: { kind: 'command', ref: '/bin/true' }, env: { TOKEN: 'secret' } })
const denied = (err) => err.code === POD_HOST_ERROR.EACCES

describe('hosted pod tenancy within one resource', () => {
  let host; let bob; let carol; let driver; let bobClient; let carolClient; let auditEntries; let carolEvents

  beforeEach(async () => {
    host = await createPeer('host')
    bob = await createPeer('bob')
    carol = await createPeer('carol')
    const nodes = wireMesh([host, bob, carol])
    driver = new InMemoryPodHostDriver({ lane: POD_LANE.NODE })
    auditEntries = []
    attachService(nodes.get(host.podId), undefined, createPodHostService({
      driver,
      auditChain: { async append(author, operation, data) { auditEntries.push({ operation, data }) } },
    }))
    host.registry.grantCapabilities(bob.podId, ALL_SCOPES)
    host.registry.grantCapabilities(carol.podId, ALL_SCOPES)
    bobClient = createPodHostClient({ peerNode: nodes.get(bob.podId), timeoutMs: 1000 })
    carolClient = createPodHostClient({ peerNode: nodes.get(carol.podId), timeoutMs: 1000 })
    carolEvents = []
    carolClient.onEvent((hostKey, event) => carolEvents.push(event))
  })

  it('the spawner may use every verb on its own pod', async () => {
    await bobClient.spawn(host.podId, SPEC('mine'))
    assert.equal((await bobClient.send(host.podId, 'mine', { hi: 1 })).delivered, true)
    assert.equal((await bobClient.exec(host.podId, 'mine', ['true'])).code, 0)
    assert.equal((await bobClient.snapshot(host.podId, 'mine')).state, 'snapshotted')
    assert.equal((await bobClient.restore(host.podId, 'mine')).state, 'registered')
    assert.equal((await bobClient.drain(host.podId, 'mine')).state, 'gone')
  })

  it('another requester holding the verbs on the resource may not send, exec, snapshot, restore or drain it', async () => {
    await bobClient.spawn(host.podId, SPEC('mine'))
    await assert.rejects(() => carolClient.send(host.podId, 'mine', { hi: 1 }), denied)
    await assert.rejects(() => carolClient.exec(host.podId, 'mine', ['true']), denied)
    await assert.rejects(() => carolClient.snapshot(host.podId, 'mine'), denied)
    await assert.rejects(() => carolClient.drain(host.podId, 'mine'), denied)
    assert.equal((await bobClient.status(host.podId, 'mine')).state, 'registered')
    await bobClient.snapshot(host.podId, 'mine')
    await assert.rejects(() => carolClient.restore(host.podId, 'mine'), denied)
    assert.equal((await bobClient.status(host.podId, 'mine')).state, 'snapshotted')
  })

  it('status of another requester\'s pod works but shows no secrets, and registers no event interest', async () => {
    await bobClient.spawn(host.podId, SPEC('mine'))
    const seen = await carolClient.status(host.podId, 'mine')
    assert.equal(seen.spec.env.TOKEN, '[redacted]')
    await bobClient.send(host.podId, 'mine', { hi: 1 })
    await bobClient.drain(host.podId, 'mine')
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(carolEvents, [], 'carol is told nothing about a pod she does not own')
  })

  it('a refusal is audited as denied and says whose pod it is not', async () => {
    await bobClient.spawn(host.podId, SPEC('mine'))
    await assert.rejects(() => carolClient.drain(host.podId, 'mine'), (err) => denied(err) && /not the owner/.test(err.message))
    const entry = auditEntries.find((e) => e.operation === 'placement_denied' && e.data.verb === 'drain')
    assert.equal(entry.data.requester, carol.podId)
    assert.equal(entry.data.name, 'mine')
    assert.ok(!JSON.stringify(entry).includes('secret'))
  })

  it('an explicit grant on the pod itself delegates exactly the verbs it names', async () => {
    await bobClient.spawn(host.podId, SPEC('mine'))
    host.registry.grantCapabilities(carol.podId, [`${RESOURCE}/mine:send`])
    assert.equal((await carolClient.send(host.podId, 'mine', { hi: 1 })).delivered, true)
    await assert.rejects(() => carolClient.drain(host.podId, 'mine'), denied)
    await bobClient.spawn(host.podId, SPEC('other'))
    await assert.rejects(() => carolClient.send(host.podId, 'other', { hi: 1 }), denied)
  })

  it('a grant of the verb on the resource alone does not delegate', async () => {
    await bobClient.spawn(host.podId, SPEC('mine'))
    host.registry.grantCapabilities(carol.podId, [`${RESOURCE}:*`])
    await assert.rejects(() => carolClient.drain(host.podId, 'mine'), denied)
  })

  it('a pod the service never saw spawned is not anyone\'s: it needs a grant on the pod', async () => {
    await driver.spawn({ name: 'direct', lane: 'node', run: { kind: 'command', ref: 'x' } })
    await assert.rejects(() => bobClient.drain(host.podId, 'direct'), denied)
    host.registry.grantCapabilities(bob.podId, [`${RESOURCE}/direct:drain`])
    assert.equal((await bobClient.drain(host.podId, 'direct')).state, 'gone')
  })

  it('a pod that does not exist is still reported as missing, not as forbidden', async () => {
    await assert.rejects(() => carolClient.drain(host.podId, 'nobody'), (err) => err.code === POD_HOST_ERROR.ENOENT)
    await assert.rejects(() => carolClient.send(host.podId, 'nobody', 1), (err) => err.code === POD_HOST_ERROR.ENOENT)
  })

  it('a name reused after a drain belongs to its new spawner', async () => {
    await bobClient.spawn(host.podId, SPEC('mine'))
    await bobClient.drain(host.podId, 'mine')
    await carolClient.spawn(host.podId, SPEC('mine'))
    await assert.rejects(() => bobClient.drain(host.podId, 'mine'), denied)
    assert.equal((await carolClient.drain(host.podId, 'mine')).state, 'gone')
  })
})
