// The CLI: its argument rules as unit tests, `main` against the in-process mesh (a fake mesh node, the real provider and a
// simulated network), and the binary as a child process (the cases that need no mesh).
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, constants, mkdtemp, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectEgress } from '../src/index.mjs'
import { createExchange } from '../src/node.mjs'
import { UsageError, USAGE, describeGrants, fromConfig, merge, parseArgv, parseScope, resolveOptions } from '../src/cli/args.mjs'
import { main, formatAudit } from '../src/cli/run.mjs'
import { threePods, simNetwork, echoOrigin, until, bytes, text, readAll, PUBLIC } from './helpers/mesh.mjs'
import { httpOrigin, ok } from './helpers/http.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BIN = path.join(root, 'bin/browsermesh-egress.mjs')
const POD_A = `podA${'A'.repeat(39)}`
const POD_B = `podB${'B'.repeat(39)}`
const SIGNAL = 'wss://signal.example.test'
const temps = []
const cleanups = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
  for (const d of temps.splice(0)) await rm(d, { recursive: true, force: true })
})
const tmp = async () => { const d = await mkdtemp(path.join(tmpdir(), 'bm-egress-cli-')); temps.push(d); return d }

const resolve = (argv, config = {}) => resolveOptions(merge(fromConfig(config), parseArgv(argv)), { now: Date.parse('2026-01-01T00:00:00Z') })
const grantFlag = (scope, peer = POD_A) => ['--allow', `${peer}=${scope}`]
const base = ['--signaling', SIGNAL, ...grantFlag('egress:tcp:registry.test:443:connect')]
const refuses = (argv, pattern, config) => assert.throws(() => resolve(argv, config), (e) => e instanceof UsageError && pattern.test(e.message), argv.join(' '))

describe('argument parsing', () => {
  it('a plain command resolves to the safe defaults: GET and HEAD, no private space, URLs audited by length only, wide off', () => {
    const o = resolve(base)
    assert.deepEqual(o.fetchMethods, ['GET', 'HEAD'])
    assert.deepEqual(o.allowPrivate, [])
    assert.equal(o.auditUrls, 'none')
    assert.equal(o.wide, false)
    assert.equal(o.identifyConsumers, false)
    assert.deepEqual(o.grants.map((g) => [g.peer, g.scopes]), [[POD_A, ['egress:tcp:registry.test:443:connect']]])
  })

  it('--flag value, --flag=value, repeated --allow, --set with ports that hold commas, --allow-private and --deny', () => {
    const o = resolve([...base, `--allow=${POD_B}=egress:set:pkgs:connect,egress:dns:registry.test:resolve`, '--set', 'pkgs=registry.test:443,*.cdn.example.test:80,443', '--allow-private', '10.0.0.0/8', '--deny=10.9.0.0/16', '--fetch-methods', 'get, post', '--audit-urls=path', '--identify-consumers'])
    assert.equal(o.grants.length, 2)
    assert.deepEqual(o.sets, { pkgs: ['registry.test:443', '*.cdn.example.test:80,443'] })
    assert.deepEqual(o.allowPrivate, ['10.0.0.0/8'])
    assert.deepEqual(o.deny, ['10.9.0.0/16'])
    assert.deepEqual(o.fetchMethods, ['GET', 'POST'])
    assert.equal(o.auditUrls, 'path')
    assert.equal(o.identifyConsumers, true)
  })

  it('the config file: grants, sets, limits, expiry; flags win and lists of both are kept', () => {
    const config = { signaling: SIGNAL, grants: [{ peer: POD_A, scopes: ['egress:udp:game.test:4000:send'], expiresAt: '2026-06-01T00:00:00Z' }], sets: { s: ['a.test:443'] }, limits: { maxUdpFlowsPerConsumer: 2 }, auditUrls: 'full', blockedPorts: [25, 465, 587, 6667] }
    const o = resolve(['--audit-urls', 'path', ...grantFlag('egress:set:s:fetch', POD_B)], config)
    assert.equal(o.auditUrls, 'path')
    assert.equal(o.grants.length, 2)
    assert.equal(o.grants[0].expiresAt, Date.parse('2026-06-01T00:00:00Z'))
    assert.deepEqual(o.limits, { maxUdpFlowsPerConsumer: 2 })
    assert.deepEqual(o.blockedPorts, [25, 465, 587, 6667])
  })

  it('unknown options, stray arguments, missing values, doubled options and a value for a switch are refused with a sentence', () => {
    for (const argv of [['--nope'], ['stray'], ['--config'], ['--config', '--json'], ['--config', 'a', '--config', 'b'], ['--wide=yes'], ['--dry-run=1']]) {
      assert.throws(() => parseArgv(argv), (e) => e instanceof UsageError && /\.$/.test(e.message), argv.join(' '))
    }
    assert.throws(() => fromConfig({ nope: 1 }), /unknown key "nope"/)
    assert.throws(() => fromConfig([]), /one JSON object/)
  })

  it('no grant, no signaling (outside a dry run), a bad signaling URL and a ws:// that is not loopback are refused', () => {
    refuses(['--signaling', SIGNAL], /At least one grant/)
    refuses(grantFlag('egress:tcp:registry.test:443:connect'), /--signaling URL is required/)
    assert.equal(resolve([...grantFlag('egress:tcp:registry.test:443:connect'), '--dry-run']).dryRun, true)
    refuses(['--signaling', 'nonsense', ...grantFlag('egress:tcp:registry.test:443:connect')], /not a URL/)
    refuses(['--signaling', 'ws://signal.example.test', ...grantFlag('egress:tcp:registry.test:443:connect')], /wss/)
    assert.equal(resolve(['--signaling', 'ws://127.0.0.1:9', ...grantFlag('egress:tcp:registry.test:443:connect')]).signaling, 'ws://127.0.0.1:9')
  })

  it('--help and -h are recognised, and the usage says what the fetch form exposes and what stays refused', () => {
    assert.equal(parseArgv(['--help']).help, true)
    assert.equal(parseArgv(['-h']).help, true)
    assert.match(USAGE, /plaintext/)
    assert.match(USAGE, /--acknowledge-wide/)
    assert.match(USAGE, /25, 465, 587/)
  })
})

describe('scopes: only the forms this package knows, so a typo cannot widen anything', () => {
  it('every form parses', () => {
    assert.deepEqual(parseScope('egress:tcp:registry.test:443:connect'), { scope: 'egress:tcp:registry.test:443:connect', family: 'tcp', host: 'registry.test', port: 443, action: 'connect', wide: false, set: null })
    assert.equal(parseScope('egress:http:api.test:*:fetch').port, '*')
    assert.equal(parseScope('egress:udp:game.test:4000:send').family, 'udp')
    assert.equal(parseScope('egress:dns:registry.test:resolve').family, 'dns')
    assert.equal(parseScope('egress:set:pkgs:fetch').set, 'pkgs')
    assert.equal(parseScope('egress:tcp:*:443:connect').wide, true)
    assert.equal(parseScope('egress:dns:*:resolve').wide, true)
    assert.equal(parseScope('egress:tcp:registry.test:*:connect').wide, false)
  })

  it('a typo, a mismatched action, a broad wildcard, a bad host, a bad port and a bare protocol scope are refused', () => {
    for (const scope of ['egress:tcp:Registry.test:443:connect', 'egress:tcp:registry.test:443:fetch', 'egress:http:registry.test:443:connect', 'egress:udp:game.test:4000:connect',
      'egress:*', '*', 'egress:tcp:*', 'egress:tcp:registry.test:99999:connect', 'egress:tcp:registry.test:0:connect', 'egress:tcp:[::1]:443:connect', 'egress:dns:Bad Name:resolve',
      'protocol:egress:open', 'egress:set:Bad:connect', 'egress:tcp:registry.test:443', 5, null]) {
      assert.throws(() => parseScope(scope), UsageError, String(scope))
    }
    refuses(['--signaling', SIGNAL, ...grantFlag('egress:*')], /not a scope of this provider/)
  })

  it('a set a grant names must exist; a pod id must be a pod id; an expiry must be in the future; unknown grant keys are refused', () => {
    refuses(['--signaling', SIGNAL, ...grantFlag('egress:set:ghost:connect')], /no set named "ghost"/)
    refuses(['--signaling', SIGNAL, ...grantFlag('egress:tcp:a.test:443:connect', 'not-a-pod')], /not a pod id/)
    refuses([], /unknown key "extra"|past/, { signaling: SIGNAL, grants: [{ peer: POD_A, scopes: ['egress:tcp:a.test:443:connect'], expiresAt: '2020-01-01T00:00:00Z' }] })
    refuses([], /unknown key "extra"/, { signaling: SIGNAL, grants: [{ peer: POD_A, scopes: ['egress:tcp:a.test:443:connect'], extra: 1 }] })
    refuses(['--signaling', SIGNAL, '--set', 'bad=*.com:443', ...grantFlag('egress:set:bad:connect')], /Destination sets/)
  })
})

describe('wide mode needs the explicit acknowledgement, every time, at the command line', () => {
  const wild = grantFlag('egress:tcp:*:443:connect')
  it('a wildcard grant without --wide is refused, naming the scope', () => {
    refuses(['--signaling', SIGNAL, ...wild], /egress:tcp:\*:443:connect is a wildcard grant.*--wide --acknowledge-wide any-public-address/)
    refuses(['--signaling', SIGNAL, ...grantFlag('egress:dns:*:resolve')], /wildcard grant/)
  })
  it('--wide without the acknowledgement, with a different one, or an acknowledgement without --wide, is refused', () => {
    refuses(['--signaling', SIGNAL, ...wild, '--wide'], /--acknowledge-wide any-public-address/)
    refuses(['--signaling', SIGNAL, ...wild, '--wide', '--acknowledge-wide', 'yes'], /--acknowledge-wide any-public-address/)
    refuses(['--signaling', SIGNAL, ...wild, '--acknowledge-wide', 'any-public-address'], /no effect without --wide/)
  })
  it('the config file cannot turn it on', () => {
    for (const key of ['wide', 'acknowledgeWide', 'acknowledge-wide']) assert.throws(() => fromConfig({ [key]: 'any-public-address' }), /not a config file setting/)
  })
  it('both flags together are accepted; --wide with no wildcard grant warns that it does nothing', () => {
    assert.equal(resolve(['--signaling', SIGNAL, ...wild, '--wide', '--acknowledge-wide', 'any-public-address']).wide, true)
    const o = resolve([...base, '--wide', '--acknowledge-wide=any-public-address'])
    assert.match(o.warnings[0], /no effect/)
  })
})

describe('the dry run', () => {
  it('says in words what each grant allows, makes the fetch form\'s plaintext plain, and starts nothing', async () => {
    const out = []
    const err = []
    let started = false
    const code = await main(['--dry-run', ...grantFlag('egress:http:api.test:443:fetch'), ...grantFlag('egress:tcp:registry.test:*:connect', POD_B), '--set', 'pkgs=a.test:443', ...grantFlag('egress:set:pkgs:send', POD_B), '--allow-private', '10.1.0.0/16'], {
      stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, startNode: async () => { started = true }, now: Date.parse('2026-01-01T00:00:00Z'),
    })
    assert.equal(code, 0, err.join(''))
    const all = out.join('')
    assert.equal(started, false)
    assert.match(all, /dry run: nothing is started/)
    assert.match(all, new RegExp(`peer ${POD_A}`))
    assert.match(all, /fetch http\(s\) URLs on api\.test, port 443\. THIS PROVIDER makes the request: it sees the URL, headers, bodies and responses in plaintext/)
    assert.match(all, /open TCP connections to registry\.test, any port/)
    assert.match(all, /send to anything the set "pkgs" lists: a\.test:443/)
    assert.match(all, /private space a named destination may resolve to: 10\.1\.0\.0\/16/)
    assert.match(all, /wide mode: off/)
    assert.deepEqual(err, [])
  })

  it('a dry run of a wide configuration says so in capitals, and a wildcard without the flags is still refused (exit 2) in a dry run', async () => {
    const out = []
    const wild = grantFlag('egress:tcp:*:443:connect')
    const stdout = { write: (s) => out.push(s) }
    const err = []
    assert.equal(await main(['--dry-run', ...wild], { stdout, stderr: { write: (s) => err.push(s) } }), 2)
    assert.match(err.join(''), /wildcard grant/)
    assert.equal(await main(['--dry-run', ...wild, '--wide', '--acknowledge-wide', 'any-public-address'], { stdout, stderr: { write: () => {} } }), 0)
    assert.match(out.join(''), /ANY PUBLIC ADDRESS \(wide mode\)/)
    assert.match(out.join(''), /wide mode: ON/)
  })

  it('a bad limit or set is found by the dry run too, not at the first request', async () => {
    const err = []
    const dir = await tmp()
    const file = path.join(dir, 'grants.json')
    await writeFile(file, JSON.stringify({ grants: [{ peer: POD_A, scopes: ['egress:tcp:a.test:443:connect'] }], limits: { maxDatagramBytes: 70000 } }))
    assert.equal(await main(['--dry-run', '--config', file], { stdout: { write: () => {} }, stderr: { write: (s) => err.push(s) } }), 2)
    assert.match(err.join(''), /65507/)
  })

  it('describeGrants is plain sentences, one per scope', () => {
    const o = resolve(['--dry-run', ...grantFlag('egress:udp:game.test:4000:send'), ...grantFlag('egress:dns:game.test:resolve')])
    const lines = describeGrants(o)
    assert.equal(lines.filter((l) => l.startsWith('peer ')).length, 2)
    assert.ok(lines.some((l) => /egress:udp:game\.test:4000:send: send UDP datagrams to game\.test, port 4000/.test(l)))
    assert.ok(lines.some((l) => /egress:dns:game\.test:resolve: look up game\.test \(A records\)/.test(l)))
  })
})

describe('main, against the in-process mesh', () => {
  /** A fake mesh node over the three in-process pods: the provider pod's service and registry, a simulated network behind the real dialer seam. */
  async function boot(argv, { startFails } = {}) {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const tcp = await echoOrigin()
    const web = await httpOrigin(ok('hello over the fetch form'))
    cleanups.push(() => tcp.close(), () => web.close())
    const net = simNetwork({ names: { 'pkg.test': [PUBLIC] }, origins: { [`${PUBLIC}:443`]: tcp.port, [`${PUBLIC}:80`]: web.port } })
    const out = []
    const err = []
    const events = []
    const proc = { once: (name, fn) => events.push([name, fn]), exit: (code) => events.push(['exit', code]) }
    let node = null
    const code = await main(argv(pods), {
      stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, process: proc,
      dialer: () => ({ dial: net.dial, resolve: net.resolve, exchange: createExchange({}) }),
      startNode: async (opts) => {
        if (startFails) throw new Error('no webrtc here')
        node = { opts, closed: false, podId: pods.provider.podId, created: true, service: pods.p, registry: pods.provider.registry, close: async () => { node.closed = true } }
        return node
      },
    })
    const lines = () => out.join('').split('\n').filter(Boolean)
    return { pods, code, out, err, events, lines, node: () => node, net }
  }

  it('starts the provider, prints the pod id to grant, applies the grants, and the consumer is served; audit lines print, without contents', async () => {
    const run = await boot((pods) => ['--signaling', SIGNAL, '--identity', '/nonexistent/identity.json', ...grantFlag('egress:tcp:pkg.test:443:connect', pods.consumer.podId), ...grantFlag('egress:http:pkg.test:80:fetch', pods.consumer.podId), ...grantFlag('egress:dns:pkg.test:resolve', pods.consumer.podId)])
    assert.equal(run.code, null)
    assert.deepEqual(run.err, [])
    assert.equal(run.node().opts.identityPath, '/nonexistent/identity.json')
    assert.equal(run.node().opts.signaling, SIGNAL)
    assert.match(run.lines()[0], new RegExp(`^browsermesh-egress pod id: ${run.pods.provider.podId} \\(new identity\\)$`))
    const link = await connectEgress(run.pods.c, run.pods.provider.podId)
    cleanups.push(() => link.close())
    const socket = await link.connect('pkg.test', 443)
    await socket.write(bytes('secret-payload-marker'))
    assert.equal(text(await socket.read()), 'secret-payload-marker')
    await socket.end()
    await readAll(socket)
    const res = await link.fetch('http://pkg.test/some/path?q=1')
    assert.equal(await res.text(), 'hello over the fetch form')
    assert.deepEqual(await link.lookup('pkg.test'), [PUBLIC])
    await until(() => run.lines().filter((l) => / egress-close /.test(l)).length === 2, 'both closes to be printed')
    const printed = run.lines().slice(2)
    assert.ok(printed.some((l) => / egress-open .*dest=pkg\.test:443 .*form=tcp/.test(l)), printed.join('\n'))
    assert.ok(printed.some((l) => / egress-open .*form=fetch/.test(l)))
    assert.ok(printed.some((l) => / egress-resolve /.test(l)))
    const joined = printed.join('\n')
    assert.ok(!joined.includes('secret-payload-marker') && !joined.includes('some/path') && !joined.includes('q=1'), 'no payload, path or query in the lines')
    assert.match(joined, /pathLength=\d+/)
    // ungranted: refused, and the refusal is printed
    await assert.rejects(link.connect('other.test', 443), (e) => e.code === 'no-grant')
    await until(() => run.lines().some((l) => / egress-refused /.test(l) && /code=no-grant/.test(l)), 'the refusal to be printed')
    // SIGINT stops the provider and the node
    const [, onInt] = run.events.find(([n]) => n === 'SIGINT')
    await onInt()
    assert.equal(run.node().closed, true)
    assert.deepEqual(run.events.at(-1), ['exit', 0])
  })

  it('--json prints each audit record as one JSON line, and --audit-urls path adds the path (and only that)', async () => {
    const run = await boot((pods) => ['--signaling', SIGNAL, '--json', '--audit-urls', 'path', ...grantFlag('egress:http:pkg.test:80:fetch', pods.consumer.podId)])
    const link = await connectEgress(run.pods.c, run.pods.provider.podId)
    cleanups.push(() => link.close())
    await (await link.fetch('http://pkg.test/where?q=1')).arrayBuffer()
    await until(() => run.lines().some((l) => l.startsWith('{') && JSON.parse(l).event === 'egress-close'), 'the close')
    const records = run.lines().filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))
    const open = records.find((r) => r.event === 'egress-open')
    assert.equal(open.path, '/where')
    assert.equal(open.query, undefined)
  })

  it('grants expire: --allow with an expiry in a config file is applied to the registry', async () => {
    const dir = await tmp()
    const file = path.join(dir, 'grants.json')
    const soon = Date.now() + 60_000
    const pods0 = await threePods()
    cleanups.push(() => pods0.teardown())
    await writeFile(file, JSON.stringify({ signaling: SIGNAL, grants: [{ peer: pods0.consumer.podId, scopes: ['egress:dns:pkg.test:resolve'], expiresAt: soon }] }))
    // the grants are read from the file; the node of boot() is its own, so check the registry call through a fake
    const calls = []
    const code = await main(['--config', file], {
      stdout: { write: () => {} }, stderr: { write: () => {} }, process: { once() {}, exit() {} },
      dialer: () => ({ dial: async () => {}, resolve: async () => [], exchange: async () => {} }),
      startNode: async () => ({ podId: pods0.provider.podId, created: false, service: pods0.p, registry: { checkAccess: () => false, grantCapabilities: (peer, scopes, o) => calls.push([peer, scopes, o]) }, close: async () => {} }),
    })
    assert.equal(code, null)
    assert.deepEqual(calls, [[pods0.consumer.podId, ['protocol:egress:open', 'egress:dns:pkg.test:resolve'], { expiresAt: soon }]])
  })

  it('a node that cannot start is exit 1 with a sentence; nothing is granted', async () => {
    const run = await boot((pods) => ['--signaling', SIGNAL, ...grantFlag('egress:dns:pkg.test:resolve', pods.consumer.podId)], { startFails: true })
    assert.equal(run.code, 1)
    assert.match(run.err.join(''), /cannot start the mesh node: no webrtc here/)
  })

  it('wide mode without the acknowledgement never reaches the node: exit 2 and startNode is not called', async () => {
    let started = false
    const err = []
    const code = await main(['--signaling', SIGNAL, ...grantFlag('egress:tcp:*:443:connect'), '--wide'], { stdout: { write: () => {} }, stderr: { write: (s) => err.push(s) }, startNode: async () => { started = true } })
    assert.equal(code, 2)
    assert.equal(started, false)
    assert.match(err.join(''), /--acknowledge-wide any-public-address/)
  })

  it('with the acknowledgement, a wildcard grant is served public addresses only', async () => {
    const run = await boot((pods) => ['--signaling', SIGNAL, '--wide', '--acknowledge-wide', 'any-public-address', ...grantFlag('egress:tcp:*:443:connect', pods.consumer.podId)])
    assert.equal(run.code, null)
    assert.match(run.lines().at(-1), /wide mode ON/)
    const link = await connectEgress(run.pods.c, run.pods.provider.podId)
    cleanups.push(() => link.close())
    await (await link.connect('pkg.test', 443)).close()
    const refused = await link.connect('10.0.0.5', 443).catch((e) => e)
    assert.ok(refused.code === 'destination-refused' && refused.addressClass === 'private', String(refused.code))
  })
})

describe('formatAudit', () => {
  it('one line: time, event, dest, then key=value; strings with spaces are quoted; undefined is left out', () => {
    const line = formatAudit({ event: 'egress-refused', at: Date.parse('2026-01-01T00:00:00Z'), outcome: 'refused', peer: 'abc', form: 'fetch', host: 'x.test', port: 443, code: 'no-grant', detail: 'has space', budget: undefined })
    assert.equal(line, '2026-01-01T00:00:00.000Z egress-refused dest=x.test:443 outcome=refused peer=abc form=fetch code=no-grant detail="has space"')
  })
})

describe('the binary', () => {
  const run = (args, { env = {} } = {}) => new Promise((resolveRun) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('close', (code) => resolveRun({ code, stdout, stderr }))
  })

  it('is the package\'s bin, executable, with a shebang', async () => {
    const pkg = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root, 'package.json'), 'utf8'))
    assert.equal(pkg.bin['browsermesh-egress'], './bin/browsermesh-egress.mjs')
    assert.ok(pkg.files.includes('bin'))
    await access(BIN, constants.X_OK)
    assert.match(await (await import('node:fs/promises')).readFile(BIN, 'utf8'), /^#!\/usr\/bin\/env node\n/)
  })

  it('--help exits 0 with the usage; a bad option exits 2 with a sentence; a dry run of a config file exits 0 and writes nothing', async () => {
    const help = await run(['--help'])
    assert.equal(help.code, 0)
    assert.match(help.stdout, /^browsermesh-egress: lend this machine's network/)
    const bad = await run(['--nope'])
    assert.equal(bad.code, 2)
    assert.match(bad.stderr, /Unknown option --nope/)
    const dir = await tmp()
    const file = path.join(dir, 'grants.json')
    await writeFile(file, JSON.stringify({ grants: [{ peer: POD_A, scopes: ['egress:tcp:registry.test:443:connect', 'egress:http:api.test:443:fetch'] }] }))
    const dry = await run(['--config', file, '--dry-run', '--identity', path.join(dir, 'identity.json')], { env: { HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: dir } })
    assert.equal(dry.code, 0, dry.stderr)
    assert.match(dry.stdout, /THIS PROVIDER makes the request/)
    assert.deepEqual((await readdir(dir)).sort(), ['grants.json'], 'no identity file was written')
  })

  it('a wildcard grant without the acknowledgement exits 2 from the binary', async () => {
    const out = await run(['--dry-run', '--allow', `${POD_A}=egress:tcp:*:443:connect`])
    assert.equal(out.code, 2)
    assert.match(out.stderr, /wildcard grant/)
  })
})
