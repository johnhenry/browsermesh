// The shape of the package: what each entry imports, what it exports, how it declares its dependencies.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))

async function files(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await files(p))
    else if (entry.name.endsWith('.mjs')) out.push(p)
  }
  return out
}
const imports = (text) => [...text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"\n]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)].map((m) => m[1] ?? m[2] ?? m[3])

describe('the browser-safe entry', () => {
  it('imports no node: module and no wsh, in any file the core entry reaches', async () => {
    const seen = new Set()
    const bad = []
    const visit = async (file) => {
      if (seen.has(file)) return
      seen.add(file)
      for (const spec of imports(await readFile(file, 'utf8'))) {
        if (spec.startsWith('node:') || ['fs', 'http', 'net', 'stream', 'crypto', 'os', 'path', 'child_process', 'dns', 'dgram', 'tls'].includes(spec)) bad.push(`${path.relative(root, file)} imports ${spec}`)
        if (spec.startsWith('@johnhenry/wsh')) bad.push(`${path.relative(root, file)} imports ${spec}`)
        if (spec.startsWith('.')) await visit(path.resolve(path.dirname(file), spec))
      }
    }
    await visit(path.join(root, 'src/index.mjs'))
    assert.deepEqual(bad, [])
    assert.ok(seen.size >= 8, 'the walk found the core files')
    assert.ok(![...seen].some((f) => f.endsWith('/node.mjs')), 'the core entry does not reach the Node entry')
  })

  it('only the ./node entry imports node: modules or wsh', async () => {
    const withNode = []
    for (const file of await files(path.join(root, 'src'))) {
      const text = await readFile(file, 'utf8')
      if (/(^|\n)\s*import[^\n]*['"]node:/.test(text) || /import\(\s*['"]@johnhenry\/wsh/.test(text)) withNode.push(path.relative(root, file))
    }
    // node-exchange.mjs is the fetch form's HTTP client (node:http, node:tls); only node.mjs imports it. src/cli is the command line, reached only from bin/.
    assert.deepEqual(withNode.filter((f) => !f.startsWith('src/cli/')).sort(), ['src/node-exchange.mjs', 'src/node.mjs'])
    for (const file of await files(path.join(root, 'src'))) {
      if (path.relative(root, file).startsWith('src/cli/')) continue
      assert.doesNotMatch(await readFile(file, 'utf8'), /cli\/(run|args|mesh-node)\.mjs/, `${path.relative(root, file)} reaches the CLI`)
    }
    for (const file of await files(path.join(root, 'src'))) {
      const text = await readFile(file, 'utf8')
      if (/from\s+['"]\.\/node-exchange\.mjs['"]/.test(text)) assert.equal(path.relative(root, file), 'src/node.mjs', `${path.relative(root, file)} imports the node exchange`)
    }
  })

  it('the core entry imports only the apps subpaths it needs and netway, at load time', async () => {
    for (const file of ['consumer.mjs', 'provider.mjs', 'backend.mjs']) {
      const text = await readFile(path.join(root, 'src', file), 'utf8')
      for (const m of text.matchAll(/^import[^'"\n]*from\s+['"]([^'"]+)['"]/gm)) {
        if (!m[1].startsWith('@')) continue
        assert.match(m[1], /^@johnhenry\/browsermesh-(apps\/(protocol-stream|protocol-channel|mesh-service|mesh-channel)|netway)$/, m[1])
      }
    }
  })

  it('nothing in the TCP or UDP path can see or alter a payload: TLS lives in the fetch form\'s exchange and nowhere else', async () => {
    for (const file of await files(path.join(root, 'src'))) {
      if (path.basename(file) === 'node-exchange.mjs') continue
      const text = await readFile(file, 'utf8')
      assert.ok(!/node:tls|from 'tls'|\bTLSSocket\b/.test(text), `${path.relative(root, file)} touches TLS`)
    }
    const exchange = await readFile(path.join(root, 'src/node-exchange.mjs'), 'utf8')
    assert.match(exchange, /node:tls/)
  })

  it('the provider\'s core never reads the environment or the process (it is also what a pod without Node runs)', async () => {
    for (const file of ['provider.mjs', 'consumer.mjs', 'wire.mjs', 'http-policy.mjs', 'limits.mjs']) {
      assert.doesNotMatch(await readFile(path.join(root, 'src', file), 'utf8'), /\bprocess\.(env|argv|exit)\b/, file)
    }
  })
})

describe('the package', () => {
  it('exports the core entry, ./browser and ./node, each typed, and ships src', () => {
    assert.deepEqual(Object.keys(pkg.exports).sort(), ['.', './browser', './node'])
    assert.equal(pkg.exports['.'].types, './src/index.d.ts')
    assert.equal(pkg.exports['./browser'].types, './src/browser.d.ts')
    assert.equal(pkg.exports['./node'].types, './src/node.d.ts')
    for (const f of ['src', 'LICENSE', 'README.md']) assert.ok(pkg.files.includes(f), f)
    assert.equal(pkg.engines.node, '>=26.0.0')
  })

  it('declares wsh as an optional peer (the provider\'s Node entry only) and the mesh packages as peers', () => {
    assert.ok(pkg.peerDependencies['@johnhenry/wsh'])
    assert.equal(pkg.peerDependenciesMeta['@johnhenry/wsh'].optional, true)
    assert.ok(pkg.peerDependencies['@johnhenry/browsermesh-apps'])
    assert.ok(pkg.peerDependencies['@johnhenry/browsermesh-netway'])
    // the dev range must admit wsh's half-close rule (0.57 and later)
    assert.match(pkg.devDependencies['@johnhenry/wsh'], /^\^0\.(5[7-9]|[6-9]\d)\./)
  })

  it('the entries export what the README says', async () => {
    const mod = await import('../src/index.mjs')
    for (const name of ['createMeshEgress', 'connectEgress', 'EgressError', 'EgressBackend', 'REFUSAL_CODES', 'BUDGET_NAMES', 'END_REASONS', 'LINK_CODES', 'EGRESS_LIMIT_DEFAULTS', 'EGRESS_SCOPES', 'DEFAULT_BLOCKED_PORTS', 'WIDE_ACKNOWLEDGEMENT']) assert.ok(mod[name] !== undefined, name)
    const node = await import('../src/node.mjs')
    assert.equal(typeof node.nodeDialer, 'function')
    assert.equal(node.createMeshEgress, mod.createMeshEgress)
  })

  it('every .d.ts names what its module exports', async () => {
    const mod = await import('../src/index.mjs')
    const dts = await readFile(path.join(root, 'src/index.d.ts'), 'utf8')
    for (const name of Object.keys(mod)) assert.match(dts, new RegExp(`\\b${name}\\b`), `${name} is not in index.d.ts`)
    const node = await import('../src/node.mjs')
    const ndts = await readFile(path.join(root, 'src/node.d.ts'), 'utf8')
    for (const name of Object.keys(node)) assert.match(ndts, new RegExp(`\\b${name}\\b`), `${name} is not in node.d.ts`)
    const browser = await import('../src/browser.mjs')
    const bdts = await readFile(path.join(root, 'src/browser.d.ts'), 'utf8')
    for (const name of Object.keys(browser)) assert.match(bdts, new RegExp(`\\b${name}\\b`), `${name} is not in browser.d.ts`)
  })
})
