// The README's tables are checked against the code, so they cannot drift: the headers that cross by default, and every
// status and reason the ingress produces.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createMeshIngress, serveHttpOnMesh, declineRequest, DEFAULT_FORWARD_REQUEST_HEADERS, DEFAULT_PASS_RESPONSE_HEADERS } from '../src/index.mjs'
import { NEVER_FORWARD_REQUEST } from '../src/headers.mjs'
import { REASON_HEADER } from '../src/errors.mjs'
import { threePods, grantHttp } from './helpers/mesh.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const readme = await readFile(path.join(root, 'README.md'), 'utf8')
const block = (name) => {
  const m = new RegExp(`<!-- ${name}:begin -->\\n([\\s\\S]*?)\\n<!-- ${name}:end -->`).exec(readme)
  assert.ok(m, `README has no ${name} block`)
  return m[1]
}
const ticks = (text) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1])
const rows = (table) => table.split('\n').filter((l) => l.startsWith('|')).slice(2).map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))

async function sources(dir) {
  const out = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...await sources(p))
    else if (e.name.endsWith('.mjs')) out.push(p)
  }
  return out
}

describe('the README header table', () => {
  const [request, response] = rows(block('headers-table'))

  it('lists exactly the request headers forwarded by default', () => {
    assert.deepEqual([...ticks(request[1])].sort(), [...DEFAULT_FORWARD_REQUEST_HEADERS].sort())
  })

  it('lists exactly the response headers passed by default (location is the one with a condition)', () => {
    assert.deepEqual([...ticks(response[1])].sort(), [...DEFAULT_PASS_RESPONSE_HEADERS].sort())
  })

  it('names every header that is never forwarded, literally or as a pattern', () => {
    const named = ticks(request[2])
    for (const name of NEVER_FORWARD_REQUEST) {
      const covered = named.some((n) => n === name || (n.endsWith('*') && name.startsWith(n.slice(0, -1))))
      assert.ok(covered, `${name} is never forwarded but the table does not say so`)
    }
    for (const n of named) assert.ok(n.endsWith('*') || NEVER_FORWARD_REQUEST.has(n), `${n} is in the table but is not on the never list`)
  })
})

describe('the README names table', () => {
  const table = rows(block('names-table')).map(([reason, mode]) => ({ reason: reason.replaceAll('`', ''), mode }))

  it('has exactly the reasons a name can be refused for', async () => {
    const text = await readFile(path.join(root, 'src/names.mjs'), 'utf8')
    const found = new Set([...text.matchAll(/(?:refuse\([^,]+, [^,]+, |new NameRefusal\()'([a-z-]+)'/g)].map((m) => m[1]))
    assert.deepEqual([...found].sort(), table.map((r) => r.reason).sort())
    for (const r of table) assert.ok(r.mode.length > 8, r.reason)
  })
})

describe('the README failure table', () => {
  const table = rows(block('failures-table')).map(([status, reason, mode]) => ({ status: Number(status), reason: reason.replaceAll('`', ''), mode }))
  const pairs = (list) => new Set(list.map((r) => `${r.status} ${r.reason}`))
  // Reasons the source builds with a condition rather than a literal pair: `code === -32603 ? 'provider-error' : 'provider-failed'`.
  const COMPUTED = [{ status: 502, reason: 'provider-error' }]

  it('has exactly the (status, reason) pairs the source produces', async () => {
    const found = []
    for (const file of await sources(path.join(root, 'src'))) {
      const text = await readFile(file, 'utf8')
      for (const m of text.matchAll(/new IngressError\((\d{3}), '([a-z-]+)'/g)) found.push({ status: Number(m[1]), reason: m[2] })
    }
    const inCode = pairs([...found, ...COMPUTED])
    const inDocs = pairs(table)
    assert.deepEqual([...inCode].filter((p) => !inDocs.has(p)), [], 'produced by the code, missing from the table')
    assert.deepEqual([...inDocs].filter((p) => !inCode.has(p)), [], 'in the table, produced by nothing')
    assert.equal(inDocs.size, table.length, 'a pair is listed twice')
  })

  it('every row says what the failure is', () => {
    for (const r of table) assert.ok(r.mode.length > 8, r.reason)
  })

  it('agrees with what a client really gets, for a sample of failure modes', async () => {
    const cleanups = []
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const served = serveHttpOnMesh(pods.p, (request) => (new URL(request.url).pathname === '/decline' ? declineRequest() : new Response('ok')), { allowFrom: [pods.ingress.podId] })
    cleanups.push(() => served.stop())
    grantHttp(pods)
    // One ingress at a time holds the channel to a provider: each case builds its own and closes it.
    const make = (opts) => opts
    const asked = async (opts, url, init) => {
      const mesh = createMeshIngress({ service: pods.i, resolve: () => ({ peer: pods.provider.podId }), ...opts })
      try { const res = await mesh.handle(new Request(url, init)); return [res.status, res.headers.get(REASON_HEADER)] } finally { await mesh.close() }
    }
    const expected = new Map(table.map((r) => [r.reason, r.status]))
    const cases = [
      [await asked(make({ resolve: () => null }), 'http://a.test/'), 'no-mapping'],
      [await asked(make({ resolve: () => ({ peer: 'has space' }) }), 'http://a.test/'), 'bad-mapping'],
      [await asked(make({ resolve: () => { throw new Error('x') } }), 'http://a.test/'), 'resolve-error'],
      [await asked(make({ authorize: () => false }), 'http://a.test/'), 'forbidden'],
      [await asked(make({ deny: () => true }), 'http://a.test/'), 'denied'],
      [await asked(make({ methods: ['GET', 'HEAD'] }), 'http://a.test/', { method: 'POST', body: 'x' }), 'method-not-allowed'],
      [await asked(make({ limits: { maxRequestBodyBytes: 4 } }), 'http://a.test/', { method: 'POST', body: 'xxxxx' }), 'body-too-large'],
      [await asked(make({ signRequest: async () => 5 }), 'http://a.test/'), 'sign-error'],
      [await asked(make({}), 'http://a.test/decline'), 'provider-declined'],
      [await asked(make({ resolve: () => ({ peer: 'podNotOnThisBus' }) }), 'http://a.test/'), 'provider-unreachable'],
    ]
    for (const [[status, reason], want] of cases) {
      assert.equal(reason, want)
      assert.equal(status, expected.get(want), `${want} is documented as ${expected.get(want)}`)
    }
    for (const c of cleanups.splice(0).reverse()) await c()
  })
})
