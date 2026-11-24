// The shape of the package: what the entries import, and what they export.
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

describe('the web-standard entry', () => {
  it('imports no node: module, in any file the core entry reaches', async () => {
    const seen = new Set()
    const nodeImports = []
    const visit = async (file) => {
      if (seen.has(file)) return
      seen.add(file)
      const text = await readFile(file, 'utf8')
      for (const spec of imports(text)) {
        if (spec.startsWith('node:') || ['fs', 'http', 'net', 'stream', 'crypto', 'os', 'path', 'child_process'].includes(spec)) nodeImports.push(`${path.relative(root, file)} imports ${spec}`)
        if (spec.startsWith('.')) await visit(path.resolve(path.dirname(file), spec))
      }
    }
    await visit(path.join(root, 'src/index.mjs'))
    assert.deepEqual(nodeImports, [])
    assert.ok(seen.size >= 6, 'the walk found the core files')
    assert.ok(![...seen].some((f) => f.endsWith('node.mjs') || f.includes('/cli/')), 'the core entry does not reach the listener or the CLI')
  })

  it('only the ./node entry and the CLI import node: modules', async () => {
    const withNode = []
    for (const file of await files(path.join(root, 'src'))) {
      if (/(^|\n)\s*import[^\n]*['"]node:/.test(await readFile(file, 'utf8'))) withNode.push(path.relative(root, file))
    }
    assert.deepEqual(withNode.sort(), ['src/cli/mesh-node.mjs', 'src/cli/run.mjs', 'src/node.mjs'])
  })

  it('imports only the apps subpaths it needs, never the whole apps index, at load time', async () => {
    for (const file of ['ingress.mjs', 'provider.mjs']) {
      const text = await readFile(path.join(root, 'src', file), 'utf8')
      const staticSpecs = [...text.matchAll(/^import[^'"\n]*from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]).filter((s) => s.startsWith('@'))
      for (const spec of staticSpecs) assert.match(spec, /^@johnhenry\/browsermesh-apps\/(protocol-stream|protocol-channel|mesh-service|mesh-channel)$/, spec)
    }
  })
})

describe('the package', () => {
  it('exports the core entry and ./node, ships src and bin, and names the bin', () => {
    assert.deepEqual(Object.keys(pkg.exports).sort(), ['.', './node'])
    assert.deepEqual(pkg.bin, { 'browsermesh-ingress': './bin/browsermesh-ingress.mjs' })
    for (const f of ['src', 'bin', 'LICENSE', 'README.md']) assert.ok(pkg.files.includes(f), f)
    assert.equal(pkg.engines.node, '>=26.0.0')
  })

  it('the core entry exports what the README says', async () => {
    const mod = await import('../src/index.mjs')
    for (const name of ['createMeshIngress', 'serveHttpOnMesh', 'fromSiteHandler', 'INGRESS_LIMIT_DEFAULTS', 'IngressError']) assert.equal(typeof mod[name], name === 'INGRESS_LIMIT_DEFAULTS' ? 'object' : 'function', name)
    const node = await import('../src/node.mjs')
    assert.equal(typeof node.listenNode, 'function')
  })
})
