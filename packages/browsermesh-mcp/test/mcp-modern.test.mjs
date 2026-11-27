/**
 * MCP 2026-07-28 ("modern": no initialize, `_meta` on every request, `server/discover`, `subscriptions/listen`) and the
 * legacy handshake, both on the same serving side; the typed client and a `@modelcontextprotocol/client` 2.x `Client`
 * through `MeshMcpTransport`, against this package's server and against a legacy-only one (wsh's handler as released).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/client'
import { webmcpTools, serveMcpOverDuplex } from '@johnhenry/wsh/page'
import { serveMcpOnMesh, connectMcpOnMesh, mcpScopes } from '../src/index.mjs'
import { bus, serviceOn, fakeWindow, tool, flush, until } from './helpers.mjs'

const V = 'io.modelcontextprotocol/protocolVersion'
const INFO = 'io.modelcontextprotocol/clientInfo'
const CAPS = 'io.modelcontextprotocol/clientCapabilities'
const SUB = 'io.modelcontextprotocol/subscriptionId'
const meta = (extra = {}) => ({ [V]: '2026-07-28', [INFO]: { name: 'test', version: '1' }, [CAPS]: {}, ...extra })

async function world({ tools = ['echo', 'buy'], grants = [...mcpScopes.open(), ...mcpScopes.tool('echo'), ...mcpScopes.tool('buy')], serve = {} } = {}) {
  const [alice, bob, eve] = await bus(3)
  const bobSvc = serviceOn(bob)
  const aliceSvc = serviceOn(alice)
  const page = fakeWindow()
  const calls = []
  const events = []
  const prompts = []
  const served = serveMcpOnMesh(bobSvc, { window: page.window, allow: ['echo', 'buy', 'late', 'a-first', 'zeta', 'mid'], prompt: async (call) => { prompts.push(call); return true }, onCall: (e) => events.push(e), ...serve })
  const run = (name) => async (input) => { calls.push({ name, input }); return `${name} ran` }
  for (const name of tools) page.register(tool(name, { execute: run(name), ...(name === 'buy' ? { annotations: { readOnlyHint: false } } : {}) }))
  bob.registry.grantCapabilities(alice.podId, grants)
  return { alice, bob, eve, aliceSvc, bobSvc, page, served, calls, events, prompts, run }
}

/** A raw channel to the server, with every message it sends recorded. */
async function raw(w) {
  const channel = await w.aliceSvc.openProtocol(w.bob.podId, 'mcp')
  const got = []
  channel.onMessage((m) => got.push(m))
  let n = 0
  return {
    channel, got,
    ask: async (method, params) => { const id = `r${++n}`; await channel.send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }); await until(() => got.some((m) => m.id === id), `answer to ${method}`); return got.find((m) => m.id === id) },
    tell: (method, params) => channel.send({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }),
  }
}

/** A legacy-only server: wsh's handler on the channel with no modern layer, as releases before this change served it. */
async function legacyWorld() {
  const [alice, bob] = await bus(2)
  const bobSvc = serviceOn(bob)
  const page = fakeWindow()
  const handler = webmcpTools({ window: page.window, allow: ['echo'], approve: 'never', timers: { setTimeout, clearTimeout, setInterval, clearInterval } })
  page.register(tool('echo'))
  const seen = []
  bobSvc.serveProtocol('mcp', (channel) => {
    const session = serveMcpOverDuplex(handler, { send: (m) => channel.send(m), who: { podId: channel.peer }, permits: () => true })
    channel.onMessage((m) => { seen.push(m.method); session.receive(m) })
    channel.onClose(() => session.close('closed'))
  })
  bob.registry.grantCapabilities(alice.podId, mcpScopes.open())
  return { alice, bob, aliceSvc: serviceOn(alice), seen }
}

test('server/discover: versions of both eras, tools capability only, no tool names, no grant beyond open', async () => {
  const w = await world({ grants: mcpScopes.open() })
  const c = await raw(w)
  const answer = await c.ask('server/discover', { _meta: meta() })
  const r = answer.result
  assert.equal(r.resultType, 'complete')
  assert.deepEqual(r.supportedVersions, ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'])
  assert.deepEqual(r.capabilities, { tools: { listChanged: true } })
  assert.equal(r.ttlMs, 0)
  assert.equal(r.cacheScope, 'private')
  assert.equal(typeof r._meta['io.modelcontextprotocol/serverInfo'].name, 'string')
  const text = JSON.stringify(r)
  for (const name of ['echo', 'buy']) assert.equal(text.includes(name), false, `discover must not name ${name}`)
  assert.equal(w.calls.length, 0)
})

test('a peer without protocol:mcp:open cannot open the channel, so it cannot discover either', async () => {
  const w = await world({ grants: [] })
  await assert.rejects(w.aliceSvc.openProtocol(w.bob.podId, 'mcp'), (e) => e.code === -32003)
})

test('modern: a request with _meta and no initialize is served; results carry resultType, the list its caching hints', async () => {
  const w = await world()
  const c = await raw(w)
  const list = (await c.ask('tools/list', { _meta: meta() })).result
  assert.equal(list.resultType, 'complete')
  assert.equal(list.ttlMs, 0)
  assert.equal(list.cacheScope, 'private', 'filtered per peer: never shareable')
  assert.deepEqual(list.tools.map((t) => t.name), ['buy', 'echo'])
  const call = (await c.ask('tools/call', { name: 'echo', arguments: { text: 'x' }, _meta: meta() })).result
  assert.equal(call.resultType, 'complete')
  assert.equal(call._meta['browsermesh/untrusted'], true, 'still labelled untrusted')
  assert.equal(call._meta['wsh/untrusted'], true)
})

test('legacy: initialize still works and a request without _meta gets the answers it always got', async () => {
  const w = await world()
  const c = await raw(w)
  const init = (await c.ask('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'old', version: '1' } })).result
  assert.equal(init.protocolVersion, '2025-06-18')
  assert.deepEqual(init.capabilities, { tools: { listChanged: true } })
  await c.tell('notifications/initialized')
  const list = (await c.ask('tools/list', {})).result
  assert.equal('resultType' in list, false)
  assert.equal('ttlMs' in list, false)
  assert.deepEqual(list.tools.map((t) => t.name), ['buy', 'echo'])
  assert.deepEqual((await c.ask('ping', {})).result, {})
})

test('an unknown protocol version is answered with the spec error and its supported list, and nothing runs', async () => {
  const w = await world()
  const c = await raw(w)
  const answer = await c.ask('tools/call', { name: 'buy', arguments: {}, _meta: meta({ [V]: '1900-01-01' }) })
  assert.equal(answer.error.code, -32022)
  assert.equal(answer.error.data.requested, '1900-01-01')
  assert.ok(answer.error.data.supported.includes('2026-07-28') && answer.error.data.supported.includes('2025-11-25'))
  assert.deepEqual(w.calls, [])
  assert.deepEqual(w.prompts, [])
})

test('nothing a peer puts in _meta changes what it may see or do', async () => {
  const w = await world({ grants: [...mcpScopes.open(), ...mcpScopes.tool('echo')] })
  const c = await raw(w)
  const loud = meta({
    [INFO]: { name: 'the-page-owner', version: '99', title: 'admin' },
    [CAPS]: { sampling: {}, roots: {}, elicitation: { form: {} }, extensions: { 'io.modelcontextprotocol/tasks': {} } },
    'wsh/untrusted': false, 'mcp:buy:call': true, permits: true, who: { podId: w.bob.podId },
  })
  assert.deepEqual((await c.ask('tools/list', { _meta: loud })).result.tools.map((t) => t.name), ['echo'])
  assert.equal((await c.ask('tools/call', { name: 'buy', arguments: {}, _meta: loud })).error.code, -32602)
  assert.deepEqual(w.calls, [])
  assert.deepEqual(w.prompts, [])
  const ok = (await c.ask('tools/call', { name: 'echo', arguments: {}, _meta: loud })).result
  assert.equal(ok._meta['wsh/untrusted'], true, 'the label is not unset by a peer')
  assert.equal(w.events.at(-1).who.podId, w.alice.podId, 'the caller is the channel\'s peer, not what _meta says')
  // Capabilities that would switch on other features switch nothing on: those methods do not exist here.
  for (const m of ['resources/list', 'prompts/list', 'tasks/get', 'sampling/createMessage', 'roots/list', 'elicitation/create']) assert.equal((await c.ask(m, { _meta: loud })).error.code, -32601, m)
})

test('tools/list is in name order, after scope filtering, whatever order the page registered in', async () => {
  const w = await world({ tools: ['zeta', 'mid', 'a-first', 'echo'], grants: [...mcpScopes.open(), 'mcp:zeta:list', 'mcp:a-first:list', 'mcp:echo:list'] })
  const c = await raw(w)
  const names = async () => (await c.ask('tools/list', { _meta: meta() })).result.tools.map((t) => t.name)
  assert.deepEqual(await names(), ['a-first', 'echo', 'zeta'])
  w.bob.registry.grantCapabilities(w.alice.podId, ['mcp:mid:list'])
  assert.deepEqual(await names(), ['a-first', 'echo', 'mid', 'zeta'])
  assert.deepEqual((await w.served.list()).map((t) => t.name), ['a-first', 'echo', 'mid', 'zeta'])
  assert.deepEqual((await c.ask('tools/list', {})).result.tools.map((t) => t.name), ['a-first', 'echo', 'mid', 'zeta'])
})

test('no error code of this package is in the range the spec reserves (-32020..-32099) except the spec\'s own', async () => {
  const w = await world({ grants: mcpScopes.open() })
  const c = await raw(w)
  const codes = new Set()
  for (const [m, p] of [['tools/call', { name: 'echo', arguments: {} }], ['nope/x', {}], ['tools/call', { arguments: {} }], ['tools/call', { name: 'echo', arguments: [] }], ['subscriptions/listen', { notifications: 5 }]]) codes.add((await c.ask(m, { ...p, _meta: meta() })).error.code)
  codes.add((await c.ask('tools/call', { name: 'x', _meta: meta({ [V]: 'nope' }) })).error.code)
  for (const code of codes) assert.ok(code === -32022 || code > -32020 || code < -32099, `${code} is reserved by the spec`)
  assert.ok(codes.has(-32022), 'the spec\'s own code is the one used for an unsupported version')
})

test('subscriptions/listen: acknowledged first, then tagged list-changed for a peer that may list; never unrequested', async () => {
  const w = await world({ tools: ['echo'], grants: [...mcpScopes.open(), 'mcp:echo:list', 'mcp:late:list'] })
  const c = await raw(w)
  // A modern peer that did not subscribe is told of nothing.
  await c.ask('tools/list', { _meta: meta() })
  const id = 'listen-1'
  await c.channel.send({ jsonrpc: '2.0', id, method: 'subscriptions/listen', params: { _meta: meta(), notifications: { toolsListChanged: true, resourcesListChanged: true, resourceSubscriptions: ['file:///x'] } } })
  await until(() => c.got.some((m) => m.method === 'notifications/subscriptions/acknowledged'), 'ack')
  const ack = c.got.find((m) => m.method === 'notifications/subscriptions/acknowledged')
  assert.equal(ack.params._meta[SUB], id)
  assert.deepEqual(ack.params.notifications, { toolsListChanged: true }, 'only what this side can do is acknowledged')
  await flush()
  w.page.register(tool('late'))
  w.page.register(tool('buy'))
  await until(() => c.got.some((m) => m.method === 'notifications/tools/list_changed'), 'list_changed')
  const changed = c.got.filter((m) => m.method === 'notifications/tools/list_changed')
  assert.equal(changed.length >= 1, true)
  assert.equal(changed[0].params._meta[SUB], id)
  assert.ok(c.got.indexOf(ack) < c.got.indexOf(changed[0]), 'nothing before the acknowledgement')
  // Cancelling the stream ends it: later changes are not sent on it.
  await c.tell('notifications/cancelled', { requestId: id })
  await flush()
  const before = c.got.length
  w.page.register(tool('zeta'))
  w.bob.registry.grantCapabilities(w.alice.podId, ['mcp:zeta:list'])
  await flush()
  assert.equal(c.got.length, before)
  assert.equal(c.got.some((m) => m.id === id), false, 'a cancelled request is not answered')
})

test('subscriptions/listen: a change the peer may not list is not announced, and the number of streams is bounded', async () => {
  const w = await world({ tools: ['echo'], grants: [...mcpScopes.open(), 'mcp:echo:list'] })
  const c = await raw(w)
  await c.channel.send({ jsonrpc: '2.0', id: 's1', method: 'subscriptions/listen', params: { _meta: meta(), notifications: { toolsListChanged: true } } })
  await until(() => c.got.some((m) => m.method === 'notifications/subscriptions/acknowledged'), 'ack')
  await flush()
  w.page.register(tool('buy')) // allowed by the page, but alice has no mcp:buy:list
  await flush()
  assert.equal(c.got.some((m) => m.method === 'notifications/tools/list_changed'), false)
  for (const id of ['s2', 's3', 's4']) await c.channel.send({ jsonrpc: '2.0', id, method: 'subscriptions/listen', params: { _meta: meta(), notifications: {} } })
  await flush()
  const over = await c.ask('subscriptions/listen', { _meta: meta(), notifications: {} })
  assert.equal(over.error.code, -32002)
})

test('the typed client goes modern on a modern server: discover, _meta on requests, list-changed over a subscription', async () => {
  const w = await world({ tools: ['echo'], grants: [...mcpScopes.open(), 'mcp:echo:list', 'mcp:echo:call', 'mcp:late:list'] })
  const client = await connectMcpOnMesh(w.aliceSvc, w.bob.podId)
  assert.equal(client.era, 'unknown')
  const init = await client.initialize()
  assert.equal(client.era, 'modern')
  assert.equal(init.protocolVersion, '2026-07-28')
  assert.deepEqual(init.capabilities, { tools: { listChanged: true } })
  assert.equal(typeof init.serverInfo.name, 'string')
  assert.equal((await client.initialize()), init, 'asking again returns the settled answer')
  assert.deepEqual((await client.listTools()).map((t) => t.name), ['echo'])
  const result = await client.callTool('echo', { text: 'hi' })
  assert.equal(result.untrusted, true)
  assert.equal(w.events.at(-1).outcome, 'ok')
  let changed = 0
  client.onToolsChanged(() => { changed++ })
  w.page.register(tool('late'))
  await until(() => changed > 0, 'a list-changed over the subscription')
  assert.deepEqual(w.served.sessions().length, 1)
  client.close()
})

test('a tool registered right after initialize() is heard (the subscription is acknowledged before it returns)', async () => {
  const w = await world({ tools: ['echo'], grants: [...mcpScopes.open(), 'mcp:echo:list', 'mcp:late:list'] })
  const client = await connectMcpOnMesh(w.aliceSvc, w.bob.podId)
  await client.initialize()
  let changed = 0
  client.onToolsChanged(() => { changed++ })
  w.page.register(tool('late'))
  await until(() => changed > 0, 'a list-changed')
})

test('the typed client falls back to legacy on a server that has no server/discover, and keeps list-changed working', async () => {
  const l = await legacyWorld()
  const client = await connectMcpOnMesh(l.aliceSvc, l.bob.podId)
  const init = await client.initialize()
  assert.equal(client.era, 'legacy')
  assert.equal(init.protocolVersion, '2025-06-18')
  assert.ok(l.seen.indexOf('server/discover') < l.seen.indexOf('initialize'))
  assert.ok(l.seen.includes('notifications/initialized'))
  assert.deepEqual((await client.listTools()).map((t) => t.name), ['echo'])
  client.close()
})

test('the typed client: era legacy skips the probe, era modern refuses the fallback', async () => {
  const l = await legacyWorld()
  const skip = await connectMcpOnMesh(l.aliceSvc, l.bob.podId)
  await skip.initialize({ era: 'legacy' })
  assert.equal(skip.era, 'legacy')
  assert.equal(l.seen.includes('server/discover'), false)
  skip.close()
  await flush()
  const strict = await connectMcpOnMesh(l.aliceSvc, l.bob.podId)
  await assert.rejects(strict.initialize({ era: 'modern' }), (e) => e.code === -32601)
  assert.equal(l.seen.filter((m) => m === 'initialize').length, 1, 'only the first client initialized')
})

test('the typed client against this server in legacy mode still hears list-changed through the old handshake', async () => {
  const w = await world({ tools: ['echo'], grants: [...mcpScopes.open(), 'mcp:echo:list', 'mcp:late:list'] })
  const client = await connectMcpOnMesh(w.aliceSvc, w.bob.podId)
  await client.initialize({ era: 'legacy' })
  assert.equal(client.era, 'legacy')
  let changed = 0
  client.onToolsChanged(() => { changed++ })
  w.page.register(tool('late'))
  await until(() => changed > 0, 'list-changed')
})

test('a 2.x SDK Client connects through MeshMcpTransport, modern first (auto), lists and calls a tool', async () => {
  const w = await world({ tools: ['echo', 'buy'], grants: [...mcpScopes.open(), ...mcpScopes.tool('echo')] })
  const mesh = await connectMcpOnMesh(w.aliceSvc, w.bob.podId)
  const sdk = new Client({ name: 'sdk-test', version: '1' }, { versionNegotiation: { mode: 'auto' } })
  await sdk.connect(mesh.transport)
  assert.equal(sdk.getProtocolEra(), 'modern')
  assert.equal(sdk.getNegotiatedProtocolVersion(), '2026-07-28')
  assert.deepEqual(sdk.getServerCapabilities().tools, { listChanged: true })
  const listed = await sdk.listTools()
  assert.deepEqual(listed.tools.map((t) => t.name), ['echo'])
  const result = await sdk.callTool({ name: 'echo', arguments: { text: 'hi' } })
  assert.equal(result.content[0].text, 'echo ran')
  assert.equal(result._meta['browsermesh/untrusted'], true)
  await assert.rejects(sdk.callTool({ name: 'buy', arguments: {} }), /unknown tool/)
  assert.deepEqual(w.calls.map((c) => c.name), ['echo'])
  await sdk.close()
})

test('a 2.x SDK Client pinned to 2026-07-28 works; one in its default (legacy) mode works too', async () => {
  for (const mode of [{ pin: '2026-07-28' }, 'legacy']) {
    const w = await world({ tools: ['echo'], grants: [...mcpScopes.open(), ...mcpScopes.tool('echo')] })
    const mesh = await connectMcpOnMesh(w.aliceSvc, w.bob.podId)
    const sdk = new Client({ name: 'sdk-test', version: '1' }, { versionNegotiation: { mode } })
    await sdk.connect(mesh.transport)
    assert.equal(sdk.getProtocolEra(), mode === 'legacy' ? 'legacy' : 'modern')
    assert.deepEqual((await sdk.listTools()).tools.map((t) => t.name), ['echo'])
    assert.equal((await sdk.callTool({ name: 'echo', arguments: {} })).content[0].text, 'echo ran')
    await sdk.close()
  }
})

test('a 2.x SDK Client (auto) falls back to legacy on a legacy-only server', async () => {
  const l = await legacyWorld()
  const mesh = await connectMcpOnMesh(l.aliceSvc, l.bob.podId)
  const sdk = new Client({ name: 'sdk-test', version: '1' }, { versionNegotiation: { mode: 'auto' } })
  await sdk.connect(mesh.transport)
  assert.equal(sdk.getProtocolEra(), 'legacy')
  assert.deepEqual((await sdk.listTools()).tools.map((t) => t.name), ['echo'])
  await sdk.close()
})

test('a modern peer is not sent the teardown log message; the channel ending is its notice', async () => {
  const w = await world()
  const c = await raw(w)
  await c.ask('tools/list', { _meta: meta() })
  assert.equal(await w.served.closeSessions('the page is closing', w.alice.podId), 1)
  await flush()
  assert.equal(c.got.some((m) => m.method === 'notifications/message'), false)
  assert.equal(c.channel.closed, true)
})
