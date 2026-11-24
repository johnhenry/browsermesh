import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BEGIN_MARKER,
  END_MARKER,
  collectFacts,
  renderFactsTable,
  checkStatusDocument,
  replaceFactsBlock,
} from './status-facts.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** A small repository tree on disk. */
async function fixtureTree() {
  const root = await mkdtemp(join(tmpdir(), 'status-facts-'))
  const put = async (path, content = '') => {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), content)
  }
  await put('packages/browsermesh-alpha/package.json', JSON.stringify({ name: '@x/browsermesh-alpha', version: '1.2.3', exports: { '.': './a.mjs', './extra': './e.mjs' } }))
  await put('packages/browsermesh-alpha/test/one.test.mjs')
  await put('packages/browsermesh-alpha/test/sub/two.test.mjs')
  await put('packages/browsermesh-alpha/test/real-peer/p.test.mjs')
  await put('packages/browsermesh-beta/package.json', JSON.stringify({ name: '@x/browsermesh-beta', version: '0.0.1', private: true }))
  await put('tests/browser/mesh.spec.mjs', "import 'packages/browsermesh-alpha/src/index.mjs'")
  return root
}

describe('collectFacts', () => {
  it('reads version, privacy, entry points, test files, real-peer and real-browser coverage from the tree', async () => {
    const root = await fixtureTree()
    try {
      const facts = await collectFacts(root)
      assert.deepEqual(facts.map((f) => f.dir), ['browsermesh-alpha', 'browsermesh-beta'])
      const [alpha, beta] = facts
      assert.equal(alpha.version, '1.2.3')
      assert.deepEqual(alpha.entryPoints, ['.', './extra'])
      assert.equal(alpha.testFiles, 3)
      assert.equal(alpha.realPeer, true)
      assert.equal(alpha.realBrowser, true)
      assert.equal(alpha.private, false)
      assert.equal(beta.private, true)
      assert.deepEqual(beta.entryPoints, ['.'])
      assert.equal(beta.testFiles, 0)
      assert.equal(beta.realPeer, false)
      assert.equal(beta.realBrowser, false)
    } finally { await rm(root, { recursive: true }) }
  })

  it('renders one row per package, deterministically', async () => {
    const root = await fixtureTree()
    try {
      const table = renderFactsTable(await collectFacts(root))
      assert.equal(table, renderFactsTable(await collectFacts(root)))
      const rows = table.split('\n').filter((l) => l.startsWith('| `'))
      assert.equal(rows.length, 2)
      assert.match(rows[0], /^\| `browsermesh-alpha` \| yes \| `\.` `\.\/extra` \| yes \| yes \| yes \|$/)
      assert.match(rows[1], /^\| `browsermesh-beta` \| private \| `\.` \| no \| no \| no \|$/)
      assert.ok(!table.includes('1.2.3'), 'a version bump must not change the document')
    } finally { await rm(root, { recursive: true }) }
  })
})

describe('checkStatusDocument', () => {
  const doc = (table, extra = '') => `intro\n\n| Package | Status | Notes |\n| --- | --- | --- |\n| \`browsermesh-alpha\` | implemented | x |\n| \`browsermesh-beta\` | partial | y |\n${extra}\n${BEGIN_MARKER}\n${table}\n${END_MARKER}\n`

  it('passes when the committed block is what the tree produces and every package has a status row', async () => {
    const root = await fixtureTree()
    try {
      const table = renderFactsTable(await collectFacts(root))
      assert.deepEqual((await checkStatusDocument({ root, document: doc(table) })).problems, [])
    } finally { await rm(root, { recursive: true }) }
  })

  it('fails when a fact in the block is out of date', async () => {
    const root = await fixtureTree()
    try {
      const stale = renderFactsTable(await collectFacts(root)).replace('`./extra`', '`./exra`')
      const { problems } = await checkStatusDocument({ root, document: doc(stale) })
      assert.ok(problems.some((p) => /generated facts are out of date/.test(p)))
    } finally { await rm(root, { recursive: true }) }
  })

  it('fails when a package has no status row, and when a row names no package', async () => {
    const root = await fixtureTree()
    try {
      const table = renderFactsTable(await collectFacts(root))
      const missing = doc(table).replace('| `browsermesh-beta` | partial | y |\n', '')
      assert.ok((await checkStatusDocument({ root, document: missing })).problems.some((p) => /browsermesh-beta.*no row/.test(p)))
      const extra = doc(table, '| `browsermesh-gamma` | partial | z |')
      assert.ok((await checkStatusDocument({ root, document: extra })).problems.some((p) => /browsermesh-gamma.*no such package/.test(p)))
    } finally { await rm(root, { recursive: true }) }
  })

  it('fails when the markers are missing', async () => {
    const root = await fixtureTree()
    try {
      const { problems } = await checkStatusDocument({ root, document: 'no markers here' })
      assert.ok(problems.some((p) => /markers/.test(p)))
    } finally { await rm(root, { recursive: true }) }
  })

  it('replaceFactsBlock rewrites only what is between the markers', () => {
    const before = `a\n${BEGIN_MARKER}\nold\n${END_MARKER}\nb\n`
    assert.equal(replaceFactsBlock(before, 'new'), `a\n${BEGIN_MARKER}\nnew\n${END_MARKER}\nb\n`)
  })
})

describe('docs/security.md in this repository', () => {
  it('has the facts the tree produces, and a status row for every package', async () => {
    const document = await readFile(join(ROOT, 'docs', 'security.md'), 'utf8')
    const { problems } = await checkStatusDocument({ root: ROOT, document })
    assert.deepEqual(problems, [], 'run `node scripts/status-facts.mjs --write` to refresh the generated block')
  })
})
