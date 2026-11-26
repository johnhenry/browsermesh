// The CLI's side of names, routes to a named service, and the link wait: its arguments, and `main` end to end over the in-memory bus.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { UsageError, createResolver, fromConfig, merge, parseArgv, parseMapping, resolveOptions } from '../src/cli/args.mjs'
import { main } from '../src/cli/run.mjs'
import { NAMES_PROTOCOL, openNameClient, serveHttpOnMesh } from '../src/index.mjs'
import { threePods, grantHttp, until } from './helpers/mesh.mjs'

const POD_A = `podA${'A'.repeat(39)}`
const POD_B = `podB${'B'.repeat(39)}`
const base = ['--signaling', 'wss://signal.example.test']
const resolve = (argv, config = { map: [] }) => resolveOptions(merge(config, parseArgv(argv)))
const refuses = (argv, pattern, config) => assert.throws(() => resolve(argv, config), (e) => e instanceof UsageError && pattern.test(e.message), argv.join(' '))

describe('--map with a service', () => {
  it('HOST[/PREFIX]=PODID#SERVICE names the service on the pod; without it nothing changes', () => {
    assert.deepEqual(parseMapping(`a.test=${POD_A}#web`), { host: 'a.test', prefix: '', peer: POD_A, service: 'web' })
    assert.deepEqual(parseMapping(`a.test/api=${POD_A}#api.v2`), { host: 'a.test', prefix: '/api', peer: POD_A, service: 'api.v2' })
    assert.deepEqual(parseMapping(`a.test=${POD_A}`), { host: 'a.test', prefix: '', peer: POD_A })
  })

  it('refuses a service that is not a short plain name', () => {
    for (const bad of ['', 'A', 'a b', 'a#b', 'x'.repeat(65), '-x']) assert.throws(() => parseMapping(`a.test=${POD_A}#${bad}`), UsageError, bad)
  })

  it('one pod may serve several services under one hostname, by path, or under several hostnames; two pods still may not share one', () => {
    const o = resolve([...base, '--map', `a.test/web=${POD_A}#web`, '--map', `a.test/api=${POD_A}#api`, '--map', `db.test=${POD_A}#db`])
    assert.deepEqual(o.mappings.map((m) => m.service), ['web', 'api', 'db'])
    refuses([...base, '--map', `a.test/x=${POD_A}#one`, '--map', `a.test/y=${POD_B}#two`], /different pods/)
    refuses([...base, '--map', `a.test=${POD_A}#one`, '--map', `a.test=${POD_A}#two`], /mapped twice/)
  })

  it('a request is routed to the service of its longest matching prefix', () => {
    const route = createResolver(['a.test/api=' + POD_A + '#api', `a.test=${POD_A}#web`].map(parseMapping))
    assert.deepEqual(route(new Request('http://a.test/api/x')), { peer: POD_A, path: '/x', service: 'api' })
    assert.deepEqual(route(new Request('http://a.test/page')), { peer: POD_A, service: 'web' })
  })
})

describe('the names flags', () => {
  const names = [...base, '--names-zone', 'pods.example.test', '--names-allow', `${POD_A}=app,blog`]

  it('serve names under a zone to the pods listed, with the library\'s defaults, and a map is no longer required', () => {
    const o = resolve(names)
    assert.deepEqual(o.names, { zone: 'pods.example.test', allow: [{ pod: POD_A, labels: ['app', 'blog'] }], deny: [], maxNames: undefined, maxPerPod: undefined, holdMs: undefined })
    assert.deepEqual(o.mappings, [])
  })

  it('are off unless a zone is given, and a zone without a pod allowed is refused', () => {
    assert.equal(resolve([...base, '--map', `a.test=${POD_A}`]).names, null)
    refuses([...base, '--names-zone', 'pods.example.test'], /--names-allow/)
    refuses([...base, '--names-allow', `${POD_A}=app`, '--map', `a.test=${POD_A}`], /--names-zone/)
    refuses([...base, '--names-hold', '5s', '--map', `a.test=${POD_A}`], /--names-zone/)
  })

  it('check the zone, the pods, the names, and the bounds', () => {
    refuses([...base, '--names-zone', 'Bad Zone', '--names-allow', `${POD_A}=app`], /--names-zone/)
    refuses([...base, '--names-zone', 'z.test', '--names-allow', `${POD_A}`], /--names-allow/)
    refuses([...base, '--names-zone', 'z.test', '--names-allow', 'bad pod=app'], /--names-allow/)
    refuses([...base, '--names-zone', 'z.test', '--names-allow', `${POD_A}=App`], /--names-allow/)
    refuses([...base, '--names-zone', 'z.test', '--names-allow', `${POD_A}=www`], /deny-list|denied|not claimable/)
    refuses([...base, '--names-zone', 'z.test', '--names-allow', `${POD_A}=app`, '--names-max', '0'], /--names-max/)
    refuses([...base, '--names-zone', 'z.test', '--names-allow', `${POD_A}=app`, '--names-max-per-pod', 'x'], /--names-max-per-pod/)
    refuses([...base, '--names-zone', 'z.test', '--names-allow', `${POD_A}=app`, '--names-hold', 'soon'], /--names-hold/)
  })

  it('a pod may be given every name with *, several pods in several flags, a hold of 0, extra denied names, and bounds', () => {
    const o = resolve([...base, '--names-zone', 'z.test', '--names-allow', `${POD_A}=*`, '--names-allow', `${POD_B}=one`, '--names-hold', '0', '--names-deny', 'staff,ops-*', '--names-max', '10', '--names-max-per-pod', '2'])
    assert.deepEqual(o.names.allow, [{ pod: POD_A, labels: ['*'] }, { pod: POD_B, labels: ['one'] }])
    assert.equal(o.names.holdMs, 0)
    assert.deepEqual(o.names.deny, ['staff', 'ops-*'])
    assert.equal(o.names.maxNames, 10)
    assert.equal(o.names.maxPerPod, 2)
  })

  it('the config file has the same keys', () => {
    const config = fromConfig({ signaling: 'wss://c.test', namesZone: 'z.test', namesAllow: { [POD_A]: ['app', 'blog'], [POD_B]: 'one' }, linkWait: '2s', readyPath: '/_ready' })
    const o = resolveOptions(merge(config, parseArgv([])))
    assert.deepEqual(o.names.allow, [{ pod: POD_A, labels: ['app', 'blog'] }, { pod: POD_B, labels: ['one'] }])
    assert.equal(o.linkWaitMs, 2000)
    assert.equal(o.readyPath, '/_ready')
  })
})

describe('--link-wait and --ready-path', () => {
  const mapped = [...base, '--map', `a.test=${POD_A}`]
  it('default to the library\'s wait and no endpoint; 0 turns the wait off', () => {
    const o = resolve(mapped)
    assert.equal(o.linkWaitMs, undefined)
    assert.equal(o.readyPath, undefined)
    assert.equal(resolve([...mapped, '--link-wait', '0']).linkWaitMs, 0)
    assert.equal(resolve([...mapped, '--link-wait', '12s']).linkWaitMs, 12_000)
  })
  it('refuse a bad duration and a path that is not a plain absolute path', () => {
    refuses([...mapped, '--link-wait', 'soon'], /--link-wait/)
    for (const bad of ['ready', '//x', '/a b', '']) refuses([...mapped, '--ready-path', bad], /--ready-path/)
    assert.equal(resolve([...mapped, '--ready-path', '/_ready']).readyPath, '/_ready')
  })
})

describe('main(): names and routes end to end', () => {
  const cleanups = []
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })
  const io = () => { const out = []; const err = []; return { out, err, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } } }
  // `fetch` will not send a Host that is not the URL's, so the request is made by hand.
  const hostGet = (port, host, path = '/') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      let text = ''
      res.on('data', (d) => { text += d })
      res.on('end', () => resolve({ status: res.statusCode, text, reason: res.headers['x-browsermesh-ingress-reason'] ?? null }))
    })
    req.on('error', reject)
    req.end()
  })

  async function start(argv) {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const t = io()
    const signals = new Map()
    const code = await main(['--listen', '127.0.0.1:0', ...base, ...argv(pods)], {
      ...t,
      process: { once: (sig, fn) => signals.set(sig, fn), exit: () => {} },
      startNode: async () => ({ podId: pods.ingress.podId, created: false, service: pods.i, node: pods.ingress, close: async () => {} }),
    })
    cleanups.push(async () => { await signals.get('SIGINT')?.() })
    assert.equal(code, null, t.err.join(''))
    const port = Number(/listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(t.out.join(''))[1])
    return { ...pods, t, port }
  }

  it('a pod that is allowed claims a name over the mesh and is then served at it; one that is not allowed is not', async () => {
    const t = await start((p) => ['--names-zone', 'pods.example.test', '--names-allow', `${p.provider.podId}=app`])
    const served = serveHttpOnMesh(t.p, (request) => new Response(`hello ${new URL(request.url).host}`), { allowFrom: [t.ingress.podId] })
    cleanups.push(() => served.stop())
    grantHttp(t)
    assert.match(t.t.out.join(''), /names: claimable under \*\.pods\.example\.test/)
    assert.equal((await hostGet(t.port, 'app.pods.example.test')).status, 404)
    const client = await openNameClient(t.p, t.ingress.podId)
    cleanups.push(async () => client.close())
    assert.equal((await client.claim('app')).host, 'app.pods.example.test')
    assert.deepEqual(await hostGet(t.port, 'app.pods.example.test'), { status: 200, text: 'hello app.pods.example.test', reason: null })
    await assert.rejects(client.claim('other'), (e) => e.reason === 'not-granted')
    const stranger = await openNameClient(t.s, t.ingress.podId).catch((e) => e)
    assert.equal(stranger.reason, 'not-authorized')
    assert.match(t.t.out.join(''), /name claim app\.pods\.example\.test/)
    assert.match(t.t.out.join(''), /name refuse .*not-granted/)
  })

  it('the protocol grant is made for the pods listed and for nobody else', async () => {
    const t = await start((p) => ['--names-zone', 'pods.example.test', '--names-allow', `${p.provider.podId}=app`])
    assert.equal(t.ingress.registry.checkAccess(t.provider.podId, `protocol:${NAMES_PROTOCOL}`, 'open').allowed, true)
    assert.equal(t.ingress.registry.checkAccess(t.provider.podId, 'ingress:name:app', 'claim').allowed, true)
    assert.equal(t.ingress.registry.checkAccess(t.provider.podId, 'ingress:name:blog', 'claim').allowed, false)
    assert.equal(t.ingress.registry.checkAccess(t.stranger.podId, `protocol:${NAMES_PROTOCOL}`, 'open').allowed, false)
  })

  it('a hostname the operator maps by hand is not claimable under the zone', async () => {
    const t = await start((p) => ['--names-zone', 'pods.example.test', '--names-allow', `${p.provider.podId}=*`, '--map', `fixed.pods.example.test=${p.provider.podId}`])
    const client = await openNameClient(t.p, t.ingress.podId)
    cleanups.push(async () => client.close())
    await assert.rejects(client.claim('fixed'), (e) => e.reason === 'name-reserved')
    assert.equal((await client.claim('free')).host, 'free.pods.example.test')
  })

  it('routes to services of one pod, by path, and refuses one the pod did not declare', async () => {
    const t = await start((p) => ['--map', `site.example.test/web=${p.provider.podId}#web`, '--map', `site.example.test/api=${p.provider.podId}#api`, '--map', `site.example.test/gone=${p.provider.podId}#gone`, '--link-wait', '0'])
    const served = serveHttpOnMesh(t.p, null, { allowFrom: [t.ingress.podId], services: { web: () => new Response('the web'), api: (request, { service }) => new Response(`api ${service} ${new URL(request.url).pathname}`) } })
    cleanups.push(() => served.stop())
    grantHttp(t)
    assert.match(t.t.out.join(''), /serving site\.example\.test\/web -> .* \(service web\)/)
    assert.equal((await hostGet(t.port, 'site.example.test', '/web/x')).text, 'the web')
    assert.equal((await hostGet(t.port, 'site.example.test', '/api/v1')).text, 'api api /v1')
    const gone = await hostGet(t.port, 'site.example.test', '/gone')
    assert.deepEqual([gone.status, gone.reason], [502, 'provider-no-service'])
  })

  it('the line printed for each request names the service after the pod; a route without one prints as it always did', async () => {
    const t = await start((p) => ['--map', `site.example.test/web=${p.provider.podId}#web`, '--map', `plain.example.test=${p.provider.podId}`, '--link-wait', '0'])
    const served = serveHttpOnMesh(t.p, () => new Response('the default'), { allowFrom: [t.ingress.podId], services: { web: () => new Response('the web') } })
    cleanups.push(() => served.stop())
    grantHttp(t)
    await hostGet(t.port, 'site.example.test', '/web/x')
    await hostGet(t.port, 'plain.example.test', '/')
    const lines = t.t.out.join('').split('\n')
    assert.ok(lines.some((l) => l.startsWith(`GET site.example.test -> ${t.provider.podId}#web 200 `)), lines.join('\n'))
    assert.ok(lines.some((l) => l.startsWith(`GET plain.example.test -> ${t.provider.podId} 200 `)), lines.join('\n'))
  })

  it('dials the mapped pods at start and answers the first request even when the pod comes a moment later; --ready-path says when', async () => {
    const t = await start((p) => ['--map', `site.example.test=${p.provider.podId}`, '--ready-path', '/_ready', '--link-wait', '20s'])
    assert.equal((await fetch(`http://127.0.0.1:${t.port}/_ready`)).status, 503)
    const first = hostGet(t.port, 'site.example.test')
    const served = serveHttpOnMesh(t.p, () => new Response('late but here'), { allowFrom: [t.ingress.podId] })
    cleanups.push(() => served.stop())
    grantHttp(t)
    assert.deepEqual(await first, { status: 200, text: 'late but here', reason: null })
    await until(async () => (await fetch(`http://127.0.0.1:${t.port}/_ready`)).status === 200, 'the endpoint to say ready')
  })
})
