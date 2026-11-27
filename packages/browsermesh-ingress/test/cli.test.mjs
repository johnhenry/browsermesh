// The CLI: its argument rules as unit tests, and the binary as a child process (the cases that need no mesh).
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { UsageError, USAGE, createResolver, fromConfig, merge, parseArgv, parseMapping, resolveOptions } from '../src/cli/args.mjs'
import { main, bearerDeny } from '../src/cli/run.mjs'

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/browsermesh-ingress.mjs')
const POD_A = `podA${'A'.repeat(39)}`
const POD_B = `podB${'B'.repeat(39)}`
const temps = []
afterEach(async () => { for (const d of temps.splice(0)) await rm(d, { recursive: true, force: true }) })
const tmp = async () => { const d = await mkdtemp(path.join(tmpdir(), 'bm-ingress-cli-')); temps.push(d); return d }

const resolve = (argv, config = { map: [] }) => resolveOptions(merge(config, parseArgv(argv)))
const base = ['--signaling', 'wss://signal.example.test', '--map', `app.example.test=${POD_A}`]
const refuses = (argv, pattern, config) => assert.throws(() => resolve(argv, config), (e) => e instanceof UsageError && pattern.test(e.message), argv.join(' '))

describe('argument parsing', () => {
  it('a plain command resolves to loopback:8080, every method, the defaults of the library', () => {
    const o = resolve(base)
    assert.deepEqual([o.host, o.port, o.public], ['127.0.0.1', 8080, false])
    assert.equal(o.methods, '*')
    assert.equal(o.uploadTimeoutMs, undefined)
    assert.equal(o.maxUploads, undefined)
    assert.deepEqual(o.mappings, [{ host: 'app.example.test', prefix: '', peer: POD_A }])
    assert.equal(o.maxBody, undefined)
    assert.equal(o.auth, null)
  })

  it('--flag value and --flag=value, repeated --map, sizes, durations and methods', () => {
    const o = resolve([...base, '--map=b.example.test=' + POD_B, '--listen=127.0.0.1:0', '--allow-methods', 'get, post,HEAD', '--max-body=128k', '--timeout', '45s', '--auth', 'bearer:/tmp/token'])
    assert.equal(o.mappings.length, 2)
    assert.equal(o.port, 0)
    assert.deepEqual(o.methods, ['GET', 'POST', 'HEAD'])
    assert.equal(o.maxBody, 128 * 1024)
    assert.equal(o.timeoutMs, 45_000)
    assert.deepEqual(o.auth, { file: '/tmp/token' })
  })

  it('IPv6 loopback in brackets is loopback', () => {
    assert.equal(resolve([...base, '--listen', '[::1]:9000']).host, '::1')
  })

  it('unknown options, stray arguments, missing values, doubled options and a value for a switch are refused with a sentence', () => {
    for (const argv of [['--nope'], ['stray'], ['--listen'], ['--listen', '--public'], ['--listen', 'a:1', '--listen', 'b:2'], ['--public=yes']]) {
      assert.throws(() => parseArgv(argv), (e) => e instanceof UsageError && /\.$/.test(e.message), argv.join(' '))
    }
  })

  it('--help and -h are recognised', () => {
    assert.equal(parseArgv(['--help']).help, true)
    assert.equal(parseArgv(['-h']).help, true)
    assert.match(USAGE, /--map HOST/)
    assert.match(USAGE, /One origin per provider/)
    assert.match(USAGE, /TLS/)
  })
})

describe('the rules the CLI enforces', () => {
  it('refuses a listen address that is not loopback, until --public AND --tls-terminated-in-front are both given', () => {
    refuses([...base, '--listen', '0.0.0.0:8080'], /--public together with --tls-terminated-in-front/)
    refuses([...base, '--listen', '0.0.0.0:8080', '--public'], /--tls-terminated-in-front/)
    refuses([...base, '--listen', '192.0.2.1:80', '--tls-terminated-in-front'], /--public/)
    const o = resolve([...base, '--listen', '0.0.0.0:8080', '--public', '--tls-terminated-in-front'])
    assert.equal(o.public, true)
    assert.ok(resolve([...base, '--public']).warnings.some((w) => /no effect/.test(w)))
  })

  it('refuses a bad --listen', () => {
    for (const bad of ['8080', 'host', ':80', 'host:70000', 'a:b', '[::1]']) refuses([...base, '--listen', bad], /--listen/)
  })

  it('needs --signaling, a URL, wss:// (ws:// only to loopback), and at least one --map', () => {
    refuses(['--map', `a.test=${POD_A}`], /--signaling/)
    refuses(['--signaling', 'nonsense', '--map', `a.test=${POD_A}`], /not a URL/)
    refuses(['--signaling', 'ws://signal.example.test', '--map', `a.test=${POD_A}`], /wss/)
    refuses(['--signaling', 'https://signal.example.test', '--map', `a.test=${POD_A}`], /wss/)
    assert.ok(resolve(['--signaling', 'ws://127.0.0.1:9', '--map', `a.test=${POD_A}`]))
    refuses(['--signaling', 'wss://s.test'], /--map/)
  })

  it('refuses a mapping that is not HOST=PODID, a host that is not a hostname and a pod id that is not one', () => {
    for (const bad of ['a.test', 'a.test=', '=podA', 'a b=podA', 'a.test=pod id', 'a.test=pod:id', 'a_b.test=podA']) refuses(['--signaling', 'wss://s.test', '--map', bad], /--map/)
    refuses(['--signaling', 'wss://s.test', '--map', `a.test/../x=${POD_A}`], /path prefix/)
    refuses(['--signaling', 'wss://s.test', '--map', `a.test//x=${POD_A}`], /path prefix/)
  })

  it('refuses two different pods under one hostname, however they are spelled', () => {
    refuses(['--signaling', 'wss://s.test', '--map', `a.test=${POD_A}`, '--map', `a.test=${POD_B}`], /mapped twice/)
    refuses(['--signaling', 'wss://s.test', '--map', `a.test/one=${POD_A}`, '--map', `a.test/two=${POD_B}`], /different pods.*One origin per provider/s)
    refuses(['--signaling', 'wss://s.test', '--map', `A.TEST/one=${POD_A}`, '--map', `a.test/two=${POD_B}`], /different pods/)
  })

  it('warns when mappings share an origin by path, even for one pod; --allow-shared-origin permits different pods, still with the warning', () => {
    const same = resolve(['--signaling', 'wss://s.test', '--map', `a.test/one=${POD_A}`, '--map', `a.test/two=${POD_A}`])
    assert.ok(same.warnings.some((w) => /share one origin/.test(w)))
    const shared = resolve(['--signaling', 'wss://s.test', '--allow-shared-origin', '--map', `a.test/one=${POD_A}`, '--map', `a.test/two=${POD_B}`])
    assert.ok(shared.warnings.some((w) => /share one origin/.test(w)))
    assert.deepEqual(resolve(base).warnings, [])
  })

  it('--allow-methods narrows: a list of method tokens, or * for every one', () => {
    assert.equal(resolve([...base, '--allow-methods', '*']).methods, '*')
    assert.deepEqual(resolve([...base, '--allow-methods', 'GET,HEAD']).methods, ['GET', 'HEAD'])
    assert.deepEqual(resolve([...base, '--allow-methods', 'get,Purge,M-SEARCH']).methods, ['GET', 'Purge', 'M-SEARCH'])
  })

  it('--max-body takes a size or "unlimited"; --max-uploads and --upload-timeout are checked', () => {
    assert.equal(resolve([...base, '--max-body', 'unlimited']).maxBody, Infinity)
    assert.equal(resolve([...base, '--max-body', '512m']).maxBody, 512 * 1024 * 1024)
    assert.equal(resolve([...base, '--max-uploads', '9', '--upload-timeout', '10m']).maxUploads, 9)
    assert.equal(resolve([...base, '--upload-timeout', '10m']).uploadTimeoutMs, 600_000)
    refuses([...base, '--max-uploads', '0'], /--max-uploads/)
    refuses([...base, '--upload-timeout', 'later'], /--upload-timeout/)
  })

  it('methods must be tokens the ingress may carry; sizes and durations must parse; --auth is bearer:FILE', () => {
    refuses([...base, '--allow-methods', 'GET,TRACE'], /--allow-methods/)
    refuses([...base, '--allow-methods', 'CONNECT'], /--allow-methods/)
    refuses([...base, '--allow-methods', 'GET,A B'], /--allow-methods/)
    refuses([...base, '--allow-methods', ','], /--allow-methods/)
    refuses([...base, '--max-body', 'lots'], /--max-body/)
    refuses([...base, '--timeout', 'soon'], /--timeout/)
    refuses([...base, '--auth', 'basic:x'], /bearer:FILE/)
  })
})

describe('the config file', () => {
  it('has the same options (camelCase or the flag spelling), a map as an object or a list, and flags win', () => {
    const config = fromConfig({ listen: '127.0.0.1:9090', signaling: 'wss://c.test', map: { 'a.test': POD_A }, allowMethods: ['GET', 'POST'], maxBody: '1m', timeout: '5s' })
    const o = resolveOptions(merge(config, parseArgv(['--listen', '127.0.0.1:7000', '--map', `b.test=${POD_B}`])))
    assert.equal(o.port, 7000)
    assert.equal(o.signaling, 'wss://c.test')
    assert.deepEqual(o.mappings.map((m) => m.host).sort(), ['a.test', 'b.test'])
    assert.deepEqual(o.methods, ['GET', 'POST'])
    assert.equal(o.maxBody, 1024 * 1024)
    assert.equal(o.timeoutMs, 5000)
    assert.ok(fromConfig({ 'allow-methods': 'GET', map: [`a.test=${POD_A}`] }))
  })
  it('refuses unknown keys, a non-object, and a bad map: a typo is never silently ignored', () => {
    for (const bad of [{ listn: '127.0.0.1:1' }, [], 'x', null, { map: 5 }, { config: 'x' }, { help: true }]) assert.throws(() => fromConfig(bad), UsageError)
  })
})

describe('mapping to a pod', () => {
  const res = (url, mappings) => createResolver(mappings.map(parseMapping))(new Request(url))
  it('a host maps to its pod; any other host is unmapped', () => {
    const m = [`a.test=${POD_A}`, `b.test:8080=${POD_B}`]
    assert.deepEqual(res('http://a.test/x', m), { peer: POD_A })
    assert.deepEqual(res('http://b.test:8080/x', m), { peer: POD_B })
    assert.equal(res('http://b.test/x', m), null)
    assert.equal(res('http://evil.test/x', m), null)
    assert.equal(res('http://a.test.evil.test/x', m), null)
  })
  it('a path prefix is stripped, matches whole segments only, and the longest prefix wins', () => {
    const m = [`a.test/app=${POD_A}`, `a.test/app/deep=${POD_A}`]
    assert.deepEqual(res('http://a.test/app', m), { peer: POD_A, path: '/' })
    assert.deepEqual(res('http://a.test/app/x/y', m), { peer: POD_A, path: '/x/y' })
    assert.deepEqual(res('http://a.test/app/deep/z', m), { peer: POD_A, path: '/z' })
    assert.equal(res('http://a.test/application', m), null)
    assert.equal(res('http://a.test/', m), null)
  })
})

describe('the bearer token', () => {
  it('a request without exactly the token is a 401 with the policy headers; with it, it passes', async () => {
    const deny = bearerDeny('0123456789abcdef-token')
    for (const auth of [undefined, '', 'Bearer', 'Bearer wrong-token-value-xxxx', 'bearer 0123456789abcdef-token', '0123456789abcdef-token', 'Bearer  0123456789abcdef-token', 'Basic 0123456789abcdef-token']) {
      const res = deny(new Request('http://a.test/', { headers: auth === undefined ? {} : { authorization: auth } }))
      assert.equal(res.status, 401, String(auth))
      assert.equal(res.headers.get('www-authenticate'), 'Bearer')
      assert.equal(res.headers.get('cache-control'), 'no-store')
    }
    assert.equal(deny(new Request('http://a.test/', { headers: { authorization: 'Bearer 0123456789abcdef-token' } })), null)
  })
})

describe('main(): exit codes and what is printed', () => {
  const io = () => { const out = []; const err = []; return { out, err, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } } }

  it('--help prints the usage and exits 0 without starting anything', async () => {
    const t = io()
    assert.equal(await main(['--help'], { ...t, startNode: () => { throw new Error('must not start') } }), 0)
    assert.match(t.out.join(''), /Usage:/)
  })

  it('bad input is exit 2 with one sentence on stderr and nothing started', async () => {
    const t = io()
    assert.equal(await main(['--listen', '0.0.0.0:80', ...base], { ...t, startNode: () => { throw new Error('must not start') } }), 2)
    assert.match(t.err.join(''), /^browsermesh-ingress: .*\.\n$/)
    assert.equal(t.out.join(''), '')
  })

  it('a missing config or token file is a usage error, not a stack trace', async () => {
    const t = io()
    assert.equal(await main(['--config', '/nonexistent/x.json'], t), 2)
    assert.match(t.err.join(''), /Cannot read the config file/)
    const t2 = io()
    assert.equal(await main([...base, '--auth', 'bearer:/nonexistent/token'], t2), 2)
    assert.match(t2.err.join(''), /token file/)
  })

  it('a token file that is too short, or has whitespace in it, is refused', async () => {
    const dir = await tmp()
    await writeFile(path.join(dir, 'short'), 'abc\n')
    await writeFile(path.join(dir, 'spaced'), 'one two three four five six\n')
    for (const f of ['short', 'spaced']) {
      const t = io()
      assert.equal(await main([...base, '--auth', `bearer:${path.join(dir, f)}`], t), 2)
      assert.match(t.err.join(''), /at least 16/)
    }
  })

  it('a node that cannot start is exit 1 with the reason, and nothing is left listening', async () => {
    const t = io()
    const code = await main(base, { ...t, startNode: async () => { const { MeshStartError } = await import('../src/cli/mesh-node.mjs'); throw new MeshStartError('WebRTC is not available: install node-datachannel.') } })
    assert.equal(code, 1)
    assert.match(t.err.join(''), /cannot start the mesh node: WebRTC is not available/)
  })

  it('with a node it lists what it serves, its pod id and where it listens, then returns null (stay up)', async () => {
    const t = io()
    const closed = []
    const signals = new Map()
    const service = { api: { openProtocol: async () => { throw new Error('unused') } } }
    const code = await main(['--listen', '127.0.0.1:0', ...base, '--allow-methods', 'GET,POST', '--max-body', '8k'], {
      ...t,
      process: { once: (sig, fn) => signals.set(sig, fn), exit: () => closed.push('exit') },
      startNode: async () => ({ podId: POD_B, created: true, service, close: async () => { closed.push('mesh') } }),
    })
    assert.equal(code, null)
    const text = t.out.join('')
    assert.match(text, new RegExp(`pod id: ${POD_B} \\(new identity\\)`))
    assert.match(text, new RegExp(`serving app\\.example\\.test -> ${POD_A}`))
    assert.match(text, /methods: GET, POST; body cap 8192 bytes; auth: none/)
    assert.match(text, /listening on http:\/\/127\.0\.0\.1:\d+/)
    await signals.get('SIGINT')()
    assert.deepEqual(closed, ['mesh', 'exit'])
  })
})

describe('the binary', () => {
  function run(args, { timeoutMs = 20_000 } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [BIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH } })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => { stdout += d })
      child.stderr.on('data', (d) => { stderr += d })
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('the CLI did not exit')) }, timeoutMs)
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
    })
  }

  it('--help exits 0 and says what it is', async () => {
    const r = await run(['--help'])
    assert.equal(r.code, 0)
    assert.match(r.stdout, /browsermesh-ingress/)
    assert.match(r.stdout, /--tls-terminated-in-front/)
    assert.equal(r.stderr, '')
  })

  it('no arguments, an unknown option and a non-loopback bind exit 2 with a sentence', async () => {
    for (const [args, pattern] of [
      [[], /--signaling URL is required/],
      [['--bogus'], /Unknown option --bogus/],
      [['--listen', '0.0.0.0:80', ...base], /--public together with --tls-terminated-in-front/],
      [['--signaling', 'wss://s.test', '--map', `a.test=${POD_A}`, '--map', `a.test/x=${POD_B}`], /different pods/],
    ]) {
      const r = await run(args)
      assert.equal(r.code, 2, args.join(' '))
      assert.match(r.stderr, pattern)
      assert.equal(r.stdout, '')
    }
  })

  it('reads a config file, and a bad one is exit 2', async () => {
    const dir = await tmp()
    await writeFile(path.join(dir, 'bad.json'), '{ not json')
    const bad = await run(['--config', path.join(dir, 'bad.json')])
    assert.equal(bad.code, 2)
    assert.match(bad.stderr, /not valid JSON/)
    await writeFile(path.join(dir, 'typo.json'), JSON.stringify({ signalling: 'wss://x' }))
    const typo = await run(['--config', path.join(dir, 'typo.json')])
    assert.equal(typo.code, 2)
    assert.match(typo.stderr, /unknown key "signalling"/)
  })
})
