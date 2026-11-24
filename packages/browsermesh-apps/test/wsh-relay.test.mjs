/**
 * A relaying pod (docs/design/wsh-over-mesh.md, "The relaying pod"): alice reaches bob's wsh services THROUGH a third pod that
 * carries the sealed session and cannot read it. Real PeerRegistries and the real mesh protocol service on an in-memory bus,
 * the real wsh client and the real WshServices. Per-target grants, default deny, bounds, no chains, revocation, and a hostile
 * relaying pod.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/wsh-relay.test.mjs
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { podIdToFingerprint } from '@johnhenry/browsermesh-primitives'
import { WshServices, WshRelay, connectWshServicesViaRelay } from '@johnhenry/browsermesh-transport'
import { pods, hostile, waitFor } from './helpers/mesh-pods.mjs'

const { openObjects } = await import('@johnhenry/wsh/objects')

const cleanups = []
afterEach(async () => { while (cleanups.length) { try { await cleanups.pop()() } catch { /* best effort */ } } })

const SECRET = 'SECRET-TEXT-0123456789'
/** A pipe relay rendezvous id: 43 base64url characters. */
const RID = 'm'.repeat(43)
const SERVICES = ['wsh-services:open', 'protocol:mcp:open', 'mcp:echo:list', 'mcp:echo:call', 'protocol:objects:open', 'objects:app:get']

/** alice (asks), relay (carries), bob (the target), eve (another requester). */
async function world({ relay: relayOptions = {}, grant = true } = {}) {
  const [alice, relay, bob, eve] = await pods(4)
  const ran = []
  const bobAudit = []
  const relayAudit = []
  const services = new WshServices({
    identity: bob.identity,
    registry: bob.registry,
    unattended: true,
    acceptVia: [relay.podId],
    mcp: { allow: ['echo'], tools: [{ name: 'echo', description: 'echoes', annotations: { readOnlyHint: true }, execute: async (i) => { ran.push(i); return `echo ${i.text ?? ''}` } }] },
    objects: { roots: { app: { title: 'inbox' } }, allow: { get: ['app.title'] } },
    onAudit: (e) => bobAudit.push(e),
  })
  await services.start()
  const stopServices = services.serveOnMesh(bob.service)
  // Bob lets the relay open his services channel, and the client's key log in (the services grants are for the KEY's pod id).
  bob.registry.grantCapabilities(relay.podId, ['protocol:wsh:open'])
  for (const p of [alice, eve]) bob.registry.grantCapabilities(p.podId, SERVICES)
  const wsh = new WshRelay({ registry: relay.registry, service: relay.service, podId: relay.podId, unattended: true, onAudit: (e) => relayAudit.push(e), ...relayOptions })
  wsh.start()
  cleanups.push(async () => { await wsh.stop(); stopServices(); await services.stop() })
  if (grant) for (const p of [alice, eve]) relay.registry.grantCapabilities(p.podId, ['protocol:wsh-relay:open', `wsh-relay:${bob.podId}:open`])
  const creds = (pod = alice) => ({ username: 'alice', keyPair: pod.identity.keyPair, timeout: 4000 })
  const dial = (from = alice, service = from.service, target = bob.podId) => connectWshServicesViaRelay(service, relay.podId, target, creds(from))
  return { alice, relay, bob, eve, wsh, services, stopServices, ran, bobAudit, relayAudit, creds, dial }
}

const reasonOf = (e) => e?.reason

describe('a relaying pod: who may ask, per target', () => {
  it('a requester with the control grant AND the grant for this target reaches the target end to end, and the target sees whose key and which relay', async () => {
    const w = await world()
    const conn = await w.dial()
    cleanups.push(() => conn.close())
    assert.equal(conn.client.sessionSealed, true)
    const mcp = await conn.client.openRpc('mcp')
    assert.equal((await mcp.request('tools/call', { name: 'echo', arguments: { text: 'hi' } })).content[0].text, 'echo hi')
    const { app } = await openObjects(conn.client)
    assert.equal(await app.title, 'inbox')
    assert.ok(w.relayAudit.some((e) => e.event === 'relay-open' && e.requester === w.alice.podId && e.target === w.bob.podId))
    assert.equal(w.wsh.sessions.length, 1)
    // The target decides on the KEY (alice's), carried by a relay it listed.
    const opened = w.bobAudit.find((e) => e.event === 'session-open')
    assert.equal(opened.podId, w.alice.podId)
    assert.equal(opened.via, w.relay.podId)
  })

  it('default deny: no control grant, no target grant, another target\'s grant, and a stranger are all refused, by name', async () => {
    const w = await world({ grant: false })
    await assert.rejects(w.dial(), (e) => e.code === -32003, 'no control grant: the protocol does not open')
    w.relay.registry.grantCapabilities(w.alice.podId, ['protocol:wsh-relay:open'])
    await assert.rejects(w.dial(), (e) => reasonOf(e) === 'no-grant')
    w.relay.registry.grantCapabilities(w.alice.podId, [`wsh-relay:${w.eve.podId}:open`])
    await assert.rejects(w.dial(), (e) => reasonOf(e) === 'no-grant', 'a grant for another target is not this one')
    assert.deepEqual(w.relayAudit.filter((e) => e.event === 'relay-open'), [])
    assert.ok(w.relayAudit.some((e) => e.event === 'relay-refused' && e.reason === 'no-grant' && e.requester === w.alice.podId))
    assert.deepEqual(w.ran, [])
  })

  it('a grant for a target that is not a pod id and is not configured is refused as an unknown target (and never dialled)', async () => {
    const w = await world()
    w.relay.registry.grantCapabilities(w.alice.podId, ['wsh-relay:nowhere:open'])
    await assert.rejects(connectWshServicesViaRelay(w.alice.service, w.relay.podId, 'nowhere', { ...w.creds(), expectHostKey: 'a'.repeat(64) }), (e) => reasonOf(e) === 'unknown-target')
  })

  it('a requester cannot name an address: only a pod id or a configured name is a target', async () => {
    const w = await world()
    for (const target of ['wss://evil.example/r/x', '10.0.0.1:22', '../x', 'a:b', 7, '']) {
      const channel = await w.alice.service.openProtocol(w.relay.podId, 'wsh-relay')
      const answers = []
      channel.onMessage((m) => { answers.push(m) })
      await channel.send({ t: 'open', target, hops: 0 })
      await waitFor(() => answers.length === 1, `the answer for ${JSON.stringify(target)}`)
      assert.deepEqual(answers[0], { t: 'refused', reason: 'bad-request' }, JSON.stringify(target))
      await waitFor(() => channel.closed, 'the channel to close')
    }
    assert.equal(w.relayAudit.some((e) => e.event === 'relay-open'), false)
  })
})

describe('a relaying pod: wildcards', () => {
  it('a wildcard target entry is refused when the relay is created, unless acknowledged', async () => {
    const [, relay] = await pods(2)
    const base = { registry: relay.registry, service: relay.service, podId: relay.podId, unattended: true }
    assert.throws(() => new WshRelay({ ...base, targets: { '*': { relay: 'wss://r.invalid', id: 'x' } } }), /wideTargets/)
    assert.doesNotThrow(() => new WshRelay({ ...base, wideTargets: true, targets: { '*': { relay: 'wss://r.invalid', id: 'x' } } }))
    assert.throws(() => new WshRelay({ ...base, targets: { [relay.podId]: { relay: 'wss://r.invalid', id: 'x' } } }), /pod id/, 'a name shaped like a pod id would be ambiguous')
    assert.throws(() => new WshRelay({ ...base, targets: { 'a b': { relay: 'wss://r.invalid', id: 'x' } } }), TypeError)
    assert.throws(() => new WshRelay({ ...base, targets: { m: { relay: 'file:///x', id: 'x' } } }), TypeError)
    assert.throws(() => new WshRelay({ ...base, protocol: 'wsh' }), /wsh/)
    assert.throws(() => new WshRelay({ registry: relay.registry, service: relay.service, podId: relay.podId }).start(), /indicator|unattended/)
  })

  it('a requester granted wsh-relay:*:open is refused (wildcard-grant) unless the relay acknowledges wideTargets', async () => {
    const w = await world({ grant: false })
    w.relay.registry.grantCapabilities(w.alice.podId, ['protocol:wsh-relay:open', 'wsh-relay:*:open'])
    await assert.rejects(w.dial(), (e) => reasonOf(e) === 'wildcard-grant')
    const wide = await world({ grant: false, relay: { wideTargets: true } })
    wide.relay.registry.grantCapabilities(wide.alice.podId, ['protocol:wsh-relay:open', 'wsh-relay:*:open'])
    const conn = await wide.dial()
    cleanups.push(() => conn.close())
    assert.equal(conn.client.sessionSealed, true)
  })
})

describe('a relaying pod: bounds, each named and audited', () => {
  it('at most maxSessions at once, and one per requesting pod (one control channel per peer)', async () => {
    const w = await world({ relay: { maxSessions: 2 } })
    const first = await w.dial()
    cleanups.push(() => first.close())
    await assert.rejects(w.dial(), (e) => /already open/.test(e.message))
    // One services channel per relay and target pod (the protocol host's rule): a second requester for the same target is told so.
    await assert.rejects(w.dial(w.eve), (e) => reasonOf(e) === 'target-busy')
    const w1 = await world({ relay: { maxSessions: 1 } })
    const a = await w1.dial()
    cleanups.push(() => a.close())
    await assert.rejects(w1.dial(w1.eve), (e) => reasonOf(e) === 'too-many-sessions')
    assert.ok(w1.relayAudit.some((e) => e.event === 'relay-refused' && e.reason === 'too-many-sessions'))
    await a.close()
    await waitFor(() => w1.wsh.sessions.length === 0, 'the place to be given back')
    const b = await w1.dial(w1.eve)
    cleanups.push(() => b.close())
  })

  it('a byte budget per session ends it, and the audit says how many bytes and why', async () => {
    const w = await world({ relay: { maxBytes: 20_000 } })
    const conn = await w.dial()
    cleanups.push(() => conn.close())
    const mcp = await conn.client.openRpc('mcp')
    await assert.rejects(mcp.request('tools/call', { name: 'echo', arguments: { text: 'x'.repeat(40_000) } }))
    await waitFor(() => w.relayAudit.some((e) => e.event === 'relay-close' && e.reason === 'byte-budget'), 'the budget to end it')
    const closed = w.relayAudit.find((e) => e.event === 'relay-close')
    assert.ok(closed.bytes > 20_000)
    assert.equal(closed.requester, w.alice.podId)
    assert.equal(closed.target, w.bob.podId)
    assert.equal(typeof closed.durationMs, 'number')
    assert.equal(JSON.stringify(w.relayAudit).includes('xxxxxxxx'), false, 'never content')
  })

  it('a time budget and an idle timeout end a session', async () => {
    const t = await world({ relay: { maxDurationMs: 30 } })
    await t.dial().catch(() => {})
    await waitFor(() => t.relayAudit.some((e) => e.event === 'relay-close' && e.reason === 'time-budget'), 'the time budget')
    const idle = await world({ relay: { idleMs: 60 } })
    const conn = await idle.dial()
    cleanups.push(() => conn.close())
    await waitFor(() => idle.relayAudit.some((e) => e.event === 'relay-close' && e.reason === 'idle'), 'the idle timeout')
    assert.equal(idle.wsh.sessions.length, 0)
  })

  it('the numbers must be positive whole numbers', async () => {
    const [, relay] = await pods(2)
    for (const bad of [0, -1, 1.5, '2']) assert.throws(() => new WshRelay({ registry: relay.registry, service: relay.service, podId: relay.podId, unattended: true, maxSessions: bad }), TypeError)
  })
})

describe('a relaying pod: no chains', () => {
  it('a request that carries any hop marker other than 0 is refused (chain), and a request naming the relay itself or the requester is a loop', async () => {
    const w = await world()
    w.relay.registry.grantCapabilities(w.alice.podId, [`wsh-relay:${w.relay.podId}:open`, `wsh-relay:${w.alice.podId}:open`])
    const ask = async (message) => {
      const channel = await w.alice.service.openProtocol(w.relay.podId, 'wsh-relay')
      const answers = []
      channel.onMessage((m) => { answers.push(m) })
      await channel.send(message)
      await waitFor(() => answers.length > 0, 'an answer')
      return answers[0]
    }
    assert.deepEqual(await ask({ t: 'open', target: w.bob.podId, hops: 1 }), { t: 'refused', reason: 'chain' })
    assert.deepEqual(await ask({ t: 'open', target: w.bob.podId }), { t: 'refused', reason: 'chain' }, 'no marker is not marker 0')
    assert.deepEqual(await ask({ t: 'open', target: w.relay.podId, hops: 0 }), { t: 'refused', reason: 'loop' })
    assert.deepEqual(await ask({ t: 'open', target: w.alice.podId, hops: 0 }), { t: 'refused', reason: 'loop' })
    assert.deepEqual(await ask('hello'), { t: 'refused', reason: 'bad-request' })
    assert.deepEqual(w.relayAudit.filter((e) => e.event === 'relay-open'), [])
  })

  it('the leg only ever opens the services protocol: a relay is never a target of a relay', async () => {
    const w = await world()
    const opened = []
    const spying = { ...w.relay.service, serveProtocol: w.relay.service.serveProtocol.bind(w.relay.service), openProtocol: (peer, name, opts) => { opened.push([peer, name]); return w.relay.service.openProtocol(peer, name, opts) } }
    const probe = new WshRelay({ registry: w.relay.registry, service: spying, podId: w.relay.podId, unattended: true, protocol: 'wsh-relay-probe' })
    probe.start()
    cleanups.push(() => probe.stop())
    w.relay.registry.grantCapabilities(w.alice.podId, ['protocol:wsh-relay-probe:open'])
    const channel = await w.alice.service.openProtocol(w.relay.podId, 'wsh-relay-probe')
    const answers = []
    channel.onMessage((m) => { answers.push(m) })
    await channel.send({ t: 'open', target: w.bob.podId, hops: 0 })
    await waitFor(() => opened.length > 0, 'the leg')
    assert.deepEqual(opened, [[w.bob.podId, 'wsh']])
    channel.close()
  })
})

describe('a relaying pod: revocation and indicator', () => {
  it('revoking the target grant ends the relayed session at once; the client\'s next call fails and nothing runs', async () => {
    const w = await world()
    const conn = await w.dial()
    cleanups.push(() => conn.close())
    const mcp = await conn.client.openRpc('mcp')
    await mcp.request('tools/call', { name: 'echo', arguments: { text: 'one' } })
    w.relay.registry.revokeCapabilities(w.alice.podId, [`wsh-relay:${w.bob.podId}:open`])
    await waitFor(() => w.relayAudit.some((e) => e.event === 'relay-close' && e.reason === 'revoked'), 'the session to end')
    assert.equal(w.wsh.sessions.length, 0)
    await assert.rejects(mcp.request('tools/call', { name: 'echo', arguments: { text: 'two' } }))
    assert.deepEqual(w.ran, [{ text: 'one' }])
    const again = w.dial()
    await assert.rejects(again, (e) => reasonOf(e) === 'no-grant')
  })

  it('revoking another requester\'s grant leaves this session alone', async () => {
    const w = await world()
    const conn = await w.dial()
    cleanups.push(() => conn.close())
    w.relay.registry.revokeCapabilities(w.eve.podId, [`wsh-relay:${w.bob.podId}:open`])
    const mcp = await conn.client.openRpc('mcp')
    assert.equal((await mcp.request('tools/call', { name: 'echo', arguments: { text: 'still' } })).content[0].text, 'echo still')
  })

  it('the relaying pod shows that it relays: the indicator is told, and its stop() ends the session', async () => {
    const shown = []
    const controls = []
    const w = await world({ relay: { unattended: false, indicator: { connected: (who, c) => { shown.push(['connected', who]); controls.push(c) }, disconnected: (who) => shown.push(['disconnected', who]) } } })
    const conn = await w.dial()
    cleanups.push(() => conn.close())
    await waitFor(() => shown.length === 1, 'the indicator')
    assert.deepEqual(shown[0], ['connected', { requester: w.alice.podId, target: w.bob.podId }])
    assert.equal(await controls[0].stop(), true)
    await waitFor(() => shown.some(([k]) => k === 'disconnected'), 'the end')
    assert.ok(w.relayAudit.some((e) => e.event === 'relay-close' && e.reason === 'stopped-by-indicator'))
  })

  it('stopping the relay ends its sessions', async () => {
    const w = await world()
    const conn = await w.dial()
    cleanups.push(() => conn.close())
    await w.wsh.stop()
    assert.ok(w.relayAudit.some((e) => e.event === 'relay-close' && e.reason === 'stopped'))
    await assert.rejects(w.dial())
  })
})

describe('a hostile relaying pod', () => {
  it('one that reads everything learns the handshake and nothing after login', async () => {
    const w = await world()
    const seen = []
    const conn = await w.dial(w.alice, hostile(w.alice.service, (direction, bytes) => { seen.push(Buffer.from(bytes)); return bytes }))
    cleanups.push(() => conn.close())
    const mcp = await conn.client.openRpc('mcp')
    assert.equal((await mcp.request('tools/call', { name: 'echo', arguments: { text: SECRET } })).content[0].text, `echo ${SECRET}`)
    const all = Buffer.concat(seen)
    assert.ok(seen.length > 4)
    for (const text of [SECRET, 'tools/call', 'echo']) assert.equal(all.includes(Buffer.from(text)), false, `${text} is not readable by the relay`)
    assert.equal(all.includes(Buffer.from('alice')), true, 'the user name is part of the plain handshake: written in the design')
  })

  it('one that alters a byte, or drops what it carries, stalls or ends the session and nothing altered runs', async () => {
    for (const mode of ['alter-to-target', 'alter-to-client', 'drop']) {
      const w = await world()
      let on = false
      const tap = (direction, bytes) => {
        if (!on) return bytes
        if (mode === 'drop') return direction === 'to-relay' ? null : bytes
        if ((mode === 'alter-to-target') !== (direction === 'to-relay')) return bytes
        const changed = new Uint8Array(bytes)
        changed[changed.length - 1] ^= 0x01
        return changed
      }
      const conn = await w.dial(w.alice, hostile(w.alice.service, tap))
      const mcp = await conn.client.openRpc('mcp')
      on = true
      const pending = mcp.request('tools/call', { name: 'echo', arguments: { text: `after-${mode}` } })
      pending.catch(() => {})
      await conn.close()
      await assert.rejects(pending, mode)
      assert.deepEqual(w.ran.filter((r) => r.text === `after-${mode}` && mode !== 'alter-to-client'), [], mode)
      await waitFor(() => w.wsh.sessions.length === 0, `the relayed session to end (${mode})`)
    }
  })

  it('one that answers as the target is refused by the client: the target\'s key is pinned, and the relay\'s is not it', async () => {
    const w = await world()
    const [imposter] = await pods(1)
    // The imposter relay is reachable from alice, says ok, and then serves ITS OWN wsh host on the channel, even granting alice.
    const own = new WshServices({ identity: imposter.identity, registry: imposter.registry, unattended: true, mcp: { allow: ['echo'], tools: [{ name: 'echo', description: 'x', annotations: { readOnlyHint: true }, execute: async () => 'forged' }] } })
    await own.start()
    cleanups.push(() => own.stop())
    imposter.registry.grantCapabilities(w.alice.podId, ['protocol:wsh-relay:open', 'wsh-services:open', 'protocol:mcp:open', 'mcp:echo:call'])
    const stop = imposter.service.serveProtocol('wsh-relay', (channel) => {
      let first = true
      channel.onMessage(async (m) => {
        if (!first) return
        first = false
        await channel.send({ t: 'ok' })
        own.serveChannel(channel)
      })
    })
    cleanups.push(() => stop())
    await assert.rejects(connectWshServicesViaRelay(w.alice.service, imposter.podId, w.bob.podId, w.creds()))
    assert.equal(own.sessions.length, 0, 'no session with the imposter was ever established')
    assert.deepEqual(w.ran, [])
  })
})

describe('a named target: a machine host behind the relaying pod, pinned by its host key', () => {
  it('reaches the machine the operator mapped, and refuses a host key that is not the one the client named', async () => {
    const { createInProcessPipeRelay } = await import('@johnhenry/wsh/testing')
    const { createMemoryHost } = await import('@johnhenry/wsh/memory')
    const { generateKeyPair, fingerprint } = await import('@johnhenry/wsh')
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const hostKey = await generateKeyPair()
    const hostFingerprint = await fingerprint(new Uint8Array(await crypto.subtle.exportKey('raw', hostKey.publicKey)))
    // One waiting host half per attempt, as a machine's wsh host keeps one at the rendezvous id.
    const slot = () => {
      const host = createMemoryHost({ hostKey, dataStreams: false, sealSession: 'require', requireChannelBinding: true, auth: () => ({ capabilities: [] }), rpc: {} })
      cleanups.push(async () => host.close())
      return host.accept(new env.WebSocket(`wss://relay.invalid/r/${RID}?role=host`)).catch(() => {})
    }
    void slot()
    const w = await world({ relay: { targets: { machine: { relay: 'wss://relay.invalid', id: RID } }, WebSocket: env.WebSocket } })
    w.relay.registry.grantCapabilities(w.alice.podId, ['wsh-relay:machine:open'])
    await assert.rejects(connectWshServicesViaRelay(w.alice.service, w.relay.podId, 'machine', { ...w.creds(), expectHostKey: 'b'.repeat(64) }), 'a host key other than the machine\'s')
    void slot()
    const conn = await connectWshServicesViaRelay(w.alice.service, w.relay.podId, 'machine', { ...w.creds(), expectHostKey: hostFingerprint })
    cleanups.push(() => conn.close())
    assert.equal(conn.client.sessionSealed, true)
    assert.ok(w.relayAudit.some((e) => e.event === 'relay-open' && e.target === 'machine'))
    await assert.rejects(connectWshServicesViaRelay(w.alice.service, w.relay.podId, 'machine', w.creds()), TypeError, 'a named target needs the host key named by the client')
  })
})

describe('the target decides which relays may carry a key to it', () => {
  it('without acceptVia a relayed login is refused at the target (the key is not the channel peer\'s)', async () => {
    const w = await world()
    const stricter = new WshServices({ identity: w.bob.identity, registry: w.bob.registry, unattended: true, mcp: { allow: [], tools: [] } })
    w.stopServices()
    await w.services.stop()
    await stricter.start()
    const stop = stricter.serveOnMesh(w.bob.service)
    cleanups.push(async () => { stop(); await stricter.stop() })
    await assert.rejects(w.dial())
  })
})
