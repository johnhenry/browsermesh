/**
 * `createMeshNode({ realm })`: the realm exchange wired into a node (host and dialler), renewal over the `realm` protocol, descriptor
 * persistence and the auto-renew timer. Real wsh links over the in-process pipe relay, the real PeerRegistry and the real
 * link-admission seam. `@johnhenry/browsermesh-realm` is a devDependency only.
 *
 * Run: node --import ./test/_setup-globals.mjs --test test/realm-node.test.mjs
 */
import 'fake-indexeddb/auto'
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { createMeshNode } from '../src/mesh-bootstrap.mjs'
import { ManualStrategy } from '@johnhenry/browsermesh-discovery'
import { createInProcessPipeRelay } from '@johnhenry/browsermesh-transport/wsh-in-process'
import { MIN_SEAM_FRAME_BYTES } from '@johnhenry/browsermesh-realm'
import { HOUR, RELAY, nowS, ROLES, waitFor, quiet, makeRealm, realmOption, allowed } from './helpers/realm-fixtures.mjs'

const cleanups = []
afterEach(async () => {
  while (cleanups.length) { try { await cleanups.pop()() } catch { /* best effort */ } }
})

let runId = 0
async function makeNode(env, label, extra = {}) {
  const node = await createMeshNode({
    label,
    signalingTransport: { send() {}, onMessage() {} },
    discoveryStrategies: [new ManualStrategy()],
    wsh: { relays: [RELAY], WebSocket: env.WebSocket, reconnect: { baseMs: 5, maxMs: 25 }, connectTimeoutMs: 3000 },
    ...extra,
    syncDbName: `realm-node-${label}-${++runId}-${Date.now()}`,
  })
  cleanups.push(async () => { await node.wsh.links.close(); await node.shutdown(); await node.signaling.close() })
  return node
}

/** A host with the realm wired in; `events` collects what the verifier and the seam report. */
async function makeHost(env, realm, over = {}, extra = {}) {
  const events = []
  const bob = await makeNode(env, 'bob', { realm: realmOption(realm, { onEvent: (e) => events.push(e), ...over }), ...extra })
  return { bob, events }
}
/** A dialler node that holds the realm's descriptor and (once it knows its key) a credential. */
async function makeDialler(env, realm, label, { credential, credentialOpts, over = {} } = {}) {
  const node = await makeNode(env, label, { realm: { pinnedId: realm.id, descriptor: realm.text, policy: {}, ...over } })
  if (credential !== null) node.realm.setCredential(credential === undefined ? await realm.credential(node.podId, credentialOpts) : credential)
  return node
}

describe('createMeshNode({ realm }): boot', () => {
  it('without the option nothing changes: no node.realm, no admission seam', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const node = await makeNode(env, 'plain')
    assert.equal(node.realm, undefined)
    assert.equal(node.admission, undefined)
    assert.equal(node.services.has('mesh-protocols'), false)
  })

  it('with the option: node.realm, the admission seam sized for descriptors, the registry policy, and the realm protocol', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const realm = await makeRealm()
    const { bob } = await makeHost(env, realm)
    for (const k of ['store', 'verifier', 'status', 'present', 'renew', 'policy', 'setCredential']) assert.ok(bob.realm[k] !== undefined, k)
    assert.equal(typeof bob.realm.present, 'function')
    assert.equal(typeof bob.realm.renew, 'function')
    assert.equal(bob.realm.store.current().serial, 1)
    assert.equal(bob.admission.maxFrameBytes, MIN_SEAM_FRAME_BYTES)
    const st = bob.realm.status()
    assert.equal(st.realmId, realm.id)
    assert.equal(st.serial, 1)
    assert.equal(st.epoch, 0)
    assert.equal(bob.services.has('mesh-protocols'), true)
    // the host's policy is the registry's: a role scope it does not list is dropped
    const g = bob.registry.grantRealmScopes({ realmId: realm.id, serial: 1, peerKey: 'k', role: 'relay', scopes: ROLES.relay, notAfter: Date.now() + 1000, epoch: 0 })
    assert.deepEqual(g.granted, [])
    const g2 = bob.registry.grantRealmScopes({ realmId: realm.id, serial: 1, peerKey: 'k', role: 'member', scopes: ROLES.member, notAfter: Date.now() + 1000, epoch: 0 })
    assert.equal(g2.granted.length, ROLES.member.length)
  })

  it('decide: a stranger is restricted, never allowed on its own; a peer the registry already lets link is allowed', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const realm = await makeRealm()
    const { bob } = await makeHost(env, realm)
    assert.equal(await bob.admission.decide({ peerKey: 'stranger', transport: 'webrtc', proven: true }), 'restrict')
    assert.equal(await bob.admission.decide({ peerKey: 'stranger', transport: 'wsh', proven: false }), 'restrict')
    bob.registry.grantCapabilities('known', ['mesh:link:connect'])
    assert.equal(await bob.admission.decide({ peerKey: 'known', transport: 'webrtc', proven: true }), 'allow')
  })

  it('an unproven link is refused and closed by the realm handler', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const realm = await makeRealm()
    const { bob, events } = await makeHost(env, realm)
    const closed = []
    const channel = { send() {}, onFrame() {}, onClose() {}, close: (r) => closed.push(r), adopt() {} }
    await bob.admission.admit({ peerKey: 'someone', transport: 'webrtc', proven: false, channel })
    await waitFor(() => closed.length > 0, 2000, 'the channel closed')
    assert.deepEqual(closed, ['unproven'])
    assert.equal(events.some((e) => e.type === 'refused' && e.reason === 'unproven'), true)
  })

  it('realm and a caller admission option are mutually exclusive', async () => {
    const realm = await makeRealm()
    await assert.rejects(
      createMeshNode({ label: 'x', signalingTransport: { send() {}, onMessage() {} }, discoveryStrategies: [new ManualStrategy()], realm: realmOption(realm), admission: { decide: () => 'deny', handler() {} }, syncDbName: `realm-node-x-${++runId}` }),
      /realm.*admission|admission.*realm/i,
    )
  })

  it('the realm package absent: a clear error, and a node without the option is unaffected', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const realm = await makeRealm()
    await assert.rejects(
      createMeshNode({
        label: 'x', signalingTransport: { send() {}, onMessage() {} }, discoveryStrategies: [new ManualStrategy()],
        realm: realmOption(realm, { loadRealmPackage: async () => { throw Object.assign(new Error('Cannot find package'), { code: 'ERR_MODULE_NOT_FOUND' }) } }),
        syncDbName: `realm-node-x-${++runId}`,
      }),
      (e) => /the realm option needs @johnhenry\/browsermesh-realm/.test(e.message) && /install @johnhenry\/browsermesh-realm/.test(e.message) && !/unpublished|private/i.test(e.message),
    )
    const ok = await makeNode(env, 'plain2')
    assert.equal(ok.realm, undefined)
  })
})

describe('the exchange over a real wsh link', () => {
  it('a stranger with a valid credential links restricted, presents with node.realm.present, is promoted, and holds exactly the role\'s scopes', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const realm = await makeRealm()
    const { bob, events } = await makeHost(env, realm)
    const alice = await makeDialler(env, realm, 'alice')
    const result = await alice.realm.present(bob.podId)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.role, 'member')
    assert.equal(typeof result.notAfter, 'number')
    await waitFor(() => bob.hasActiveSession(alice.podId), 4000, 'promoted link is a session')
    assert.equal(bob.admission.stats().promoted, 1)
    for (const scope of ROLES.member) assert.equal(allowed(bob, alice.podId, scope), true, scope)
    for (const scope of ['mcp:search:delete', 'files:home:read', 'egress:tcp:connect']) assert.equal(allowed(bob, alice.podId, scope), false, scope)
    assert.equal(bob.registry.listRealmGrants({ realmId: realm.id })[0].peerKey, alice.podId)
    assert.equal(events.some((e) => e.type === 'granted' && e.role === 'member'), true)
    assert.equal(alice.realm.status().peers.find((p) => p.podId === bob.podId).role, 'member')
    // the link stays up through an access change: the grant was written before promote
    bob.registry.grantCapabilities(alice.podId, ['notes:doc:read'])
    await quiet(150)
    assert.equal(bob.wsh.links.isConnected(alice.podId), true)
  })

  it('the host policy drops an egress: role scope and reports it', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const realm = await makeRealm()
    const { bob, events } = await makeHost(env, realm, { policy: { [realm.id]: { roles: { relay: ['mesh:link:connect', 'protocol:mcp:open'] } } } })
    const alice = await makeDialler(env, realm, 'alice', { credentialOpts: { role: 'relay' } })
    const result = await alice.realm.present(bob.podId)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.role, 'relay')
    const granted = events.find((e) => e.type === 'granted')
    assert.deepEqual(granted.dropped.map((d) => d.scope), ['egress:tcp:connect'])
    assert.equal(allowed(bob, alice.podId, 'egress:tcp:connect'), false)
    assert.equal(allowed(bob, alice.podId, 'protocol:mcp:open'), true)
  })

  it('open mode: a guest with no credential gets exactly the guest scopes', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const realm = await makeRealm({ mode: 'open' })
    const { bob } = await makeHost(env, realm)
    const alice = await makeDialler(env, realm, 'alice', { credential: null })
    const result = await alice.realm.present(bob.podId)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.role, 'guest')
    for (const scope of ROLES.guest) assert.equal(allowed(bob, alice.podId, scope), true, scope)
    assert.equal(allowed(bob, alice.podId, 'mcp:search:call'), false)
  })

  it('invite mode with no credential: refused no-credential, nothing granted', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const realm = await makeRealm()
    const { bob, events } = await makeHost(env, realm)
    const alice = await makeDialler(env, realm, 'alice', { credential: null })
    assert.deepEqual(await alice.realm.present(bob.podId), { ok: false, reason: 'no-credential' })
    await waitFor(() => events.some((e) => e.type === 'refused' && e.reason === 'no-credential'))
    assert.equal(bob.registry.listRealmGrants().length, 0)
    assert.equal(bob.hasActiveSession(alice.podId), false)
  })

  it('a credential issued to another key is refused (subject-mismatch)', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const realm = await makeRealm()
    const { bob } = await makeHost(env, realm)
    const stranger = await makeNode(env, 'stranger')
    const alice = await makeDialler(env, realm, 'alice', { credential: await realm.credential(stranger.podId) })
    assert.deepEqual(await alice.realm.present(bob.podId), { ok: false, reason: 'subject-mismatch' })
    assert.equal(bob.registry.listRealmGrants().length, 0)
  })

  it('a stranger holding no descriptor learns it from the host', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const realm = await makeRealm()
    const { bob } = await makeHost(env, realm)
    const alice = await makeNode(env, 'alice', { realm: { pinnedId: realm.id, policy: {} } })
    assert.equal(alice.realm.store.current(), null)
    alice.realm.setCredential(await realm.credential(alice.podId))
    const result = await alice.realm.present(bob.podId)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(alice.realm.store.current().serial, 1)
  })

  it('automatic: a node with a credential presents itself when it connects to a peer it holds no grant from', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const realm = await makeRealm()
    const { bob } = await makeHost(env, realm)
    const seen = []
    const alice = await makeDialler(env, realm, 'alice', { over: { onEvent: (e) => { if (e.type === 'presented') seen.push(e) } } })
    await alice.connectToPeer(bob.podId, { wsh: bob.podId })
    await waitFor(() => bob.hasActiveSession(alice.podId), 4000, 'auto presentation promoted the link')
    await waitFor(() => seen.length === 1, 2000, 'realm:presented')
    assert.equal(seen[0].podId, bob.podId)
    assert.equal(seen[0].result.ok, true)
    assert.equal(allowed(bob, alice.podId, 'mcp:search:call'), true)
  })

  it('peer-does-not-speak-realms against a plain node, after the timeout; the link is left alone', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const realm = await makeRealm()
    const plain = await makeNode(env, 'plain')
    const alice = await makeDialler(env, realm, 'alice')
    plain.registry.grantCapabilities(alice.podId, ['mesh:link:connect'])
    const started = Date.now()
    const result = await alice.realm.present(plain.podId, { timeoutMs: 300 })
    assert.deepEqual(result, { ok: false, reason: 'peer-does-not-speak-realms' })
    assert.ok(Date.now() - started < 3000)
    assert.equal(plain.wsh.links.isConnected(alice.podId), true)
  })

  it('a host that is unreachable: present resolves {ok:false}, never hangs', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const realm = await makeRealm()
    const alice = await makeDialler(env, realm, 'alice')
    const result = await alice.realm.present('not-a-live-pod-id', { timeoutMs: 300 })
    assert.equal(result.ok, false)
    assert.ok(typeof result.reason === 'string')
  })

  it('an epoch bump (descriptor update) revokes older-epoch grants and closes the link at the next re-check', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const realm = await makeRealm()
    const { bob } = await makeHost(env, realm)
    const alice = await makeDialler(env, realm, 'alice')
    assert.equal((await alice.realm.present(bob.podId)).ok, true)
    await waitFor(() => bob.hasActiveSession(alice.podId))
    const bumped = await realm.sign({ serial: 2, epoch: 1 })
    assert.equal((await bob.realm.store.offer(bumped.text, { linkId: 'operator' })).ok, true)
    await waitFor(() => !bob.wsh.links.isConnected(alice.podId), 4000, 'the link is closed by the access re-check')
    assert.equal(bob.registry.listRealmGrants().length, 0)
    assert.equal(bob.realm.status().epoch, 1)
  })
})

describe('renewal over the realm protocol', () => {
  async function granted(env, realm, hostOver = {}) {
    const { bob, events } = await makeHost(env, realm, hostOver)
    const alice = await makeDialler(env, realm, 'alice')
    assert.equal((await alice.realm.present(bob.podId)).ok, true)
    await waitFor(() => bob.hasActiveSession(alice.podId))
    return { bob, alice, events }
  }
  const serialOf = (bob, alice) => bob.registry.listRealmGrants({ peerKey: alice.podId })[0]?.serial

  it('a peer with a live grant renews with a newer-serial credential: the grant is replaced', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const realm = await makeRealm()
    const { bob, alice } = await granted(env, realm)
    const first = bob.registry.listRealmGrants({ peerKey: alice.podId })[0]
    const res = await alice.realm.renew(bob.podId, await realm.credential(alice.podId, { serial: 2, notAfter: nowS() + 2 * HOUR }))
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.equal(res.role, 'member')
    const grants = bob.registry.listRealmGrants({ peerKey: alice.podId })
    assert.equal(grants.length, 1)
    assert.equal(grants[0].serial, 2)
    assert.ok(grants[0].notAfter > first.notAfter)
    assert.equal(bob.wsh.links.isConnected(alice.podId), true)
    assert.equal(alice.realm.status().peers.find((p) => p.podId === bob.podId).notAfter, res.notAfter)
  })

  it('an OLDER serial is refused (stale-serial) and the newer grant stands', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const realm = await makeRealm()
    const { bob, alice } = await granted(env, realm)
    assert.equal((await alice.realm.renew(bob.podId, await realm.credential(alice.podId, { serial: 5 }))).ok, true)
    const stale = await alice.realm.renew(bob.podId, await realm.credential(alice.podId, { serial: 3, notAfter: nowS() + 5 * HOUR }))
    assert.deepEqual(stale, { ok: false, reason: 'stale-serial' })
    assert.equal(serialOf(bob, alice), 5)
  })

  it('a credential issued to another key is refused over the seam too (subject = the channel\'s verified peer)', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const realm = await makeRealm()
    const { bob, alice } = await granted(env, realm)
    const stranger = await makeNode(env, 'stranger')
    const res = await alice.realm.renew(bob.podId, await realm.credential(stranger.podId, { serial: 9 }))
    assert.deepEqual(res, { ok: false, reason: 'subject-mismatch' })
    assert.equal(serialOf(bob, alice), 1)
  })

  it('without a live realm grant, renewal is refused (not-authorized), even for a peer the operator lets link', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const realm = await makeRealm()
    const { bob } = await makeHost(env, realm)
    const carol = await makeDialler(env, realm, 'carol', { credential: null })
    bob.registry.grantCapabilities(carol.podId, ['mesh:link:connect', 'protocol:mcp:open'])
    await carol.connectToPeer(bob.podId, { wsh: bob.podId })
    const res = await carol.realm.renew(bob.podId, await realm.credential(carol.podId, { serial: 2 }))
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'not-authorized')
    assert.equal(bob.registry.listRealmGrants().length, 0)
  })

  it('a renewal that carries a newer descriptor delivers it to the host (serial bump, same epoch)', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const realm = await makeRealm()
    const { bob } = await makeHost(env, realm)
    const newer = await realm.sign({ serial: 2 })
    const alice = await makeDialler(env, realm, 'alice', { over: { descriptor: newer.text } })
    // alice holds serial 2, bob serial 1: the exchange delivers it on the first link already
    assert.equal((await alice.realm.present(bob.podId)).ok, true)
    assert.equal(bob.realm.store.current().serial, 2)
    const newest = await realm.sign({ serial: 3 })
    assert.equal((await alice.realm.store.offer(newest.text)).ok, true)
    const res = await alice.realm.renew(bob.podId, await realm.credential(alice.podId, { serial: 2 }))
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.equal(bob.realm.store.current().serial, 3)
  })

  it('autoRenew re-presents before notAfter, and its timer is cleared on shutdown', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const realm = await makeRealm()
    const { bob } = await makeHost(env, realm)
    let provided = 0
    let alice
    alice = await makeDialler(env, realm, 'alice', {
      credentialOpts: { serial: 1, notAfter: nowS() + 5 },
      over: { autoRenew: { beforeSeconds: 4, credentialProvider: async () => { provided++; return realm.credential(alice.podId, { serial: 2, notAfter: nowS() + HOUR }) } } },
    })
    assert.equal((await alice.realm.present(bob.podId)).ok, true)
    assert.equal(alice.realm.status().autoRenewArmed, true)
    await waitFor(() => provided === 1, 5000, 'the provider was asked')
    await waitFor(() => bob.registry.listRealmGrants({ peerKey: alice.podId })[0]?.serial === 2, 3000, 'the grant was renewed')
    // the renewed credential is good for an hour: the timer re-arms for it, one timer for the realm
    await waitFor(() => alice.realm.status().autoRenewArmed && alice.realm.status().peers[0]?.notAfter > nowS() + HOUR - 5, 3000, 'the timer re-armed for the renewed credential')
    await alice.shutdown()
    assert.equal(alice.realm.status().autoRenewArmed, false)
  })

  it('autoRenew armed then shutdown: no timer is left and the provider is never asked', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const realm = await makeRealm()
    const { bob } = await makeHost(env, realm)
    let provided = 0
    const alice = await makeDialler(env, realm, 'alice', {
      credentialOpts: { notAfter: nowS() + 3 },
      over: { autoRenew: { beforeSeconds: 2, credentialProvider: async () => { provided++; return null } } },
    })
    assert.equal((await alice.realm.present(bob.podId)).ok, true)
    assert.equal(alice.realm.status().autoRenewArmed, true)
    await alice.shutdown()
    assert.equal(alice.realm.status().autoRenewArmed, false)
    await quiet(1500)
    assert.equal(provided, 0)
  })
})

describe('persistence', () => {
  it('persist.save is called on adopt with the store\'s export; persist.load restores held', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const realm = await makeRealm()
    const saved = []
    const newer = await realm.sign({ serial: 2 })
    // the baked descriptor (serial 1) is older than what was persisted (serial 2): the persisted one wins
    const { bob } = await makeHost(env, realm, { persist: { load: async () => newer.text, save: (t) => { saved.push(t) } } })
    assert.equal(bob.realm.store.current().serial, 2)
    assert.equal(saved.length, 0)
    const newest = await realm.sign({ serial: 3 })
    assert.equal((await bob.realm.store.offer(newest.text)).ok, true)
    assert.equal(saved.length, 1)
    assert.equal(saved[0], bob.realm.store.export())
  })

  it('with nothing persisted the baked descriptor is adopted and saved', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const realm = await makeRealm()
    const saved = []
    const { bob } = await makeHost(env, realm, { persist: { load: () => null, save: (t) => saved.push(t) } })
    assert.equal(bob.realm.store.current().serial, 1)
    assert.deepEqual(saved, [realm.text])
  })

  it('a persist.save that throws does not break adoption', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const realm = await makeRealm()
    const { bob } = await makeHost(env, realm, { persist: { load: () => null, save: () => { throw new Error('disk full') } } })
    const newer = await realm.sign({ serial: 2 })
    assert.equal((await bob.realm.store.offer(newer.text)).ok, true)
    assert.equal(bob.realm.store.current().serial, 2)
  })
})
