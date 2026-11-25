// What only a KVM host can settle: one numbered list at the top of docs/hosted-pods.md, each step pointing at a section
// of the runbook that exists, and the runbook itself naming only files and commands that exist.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const pods = await readFile(join(ROOT, 'docs', 'hosted-pods.md'), 'utf8')
const runbook = await readFile(join(ROOT, 'docs', 'runbook-firecracker-kvm.md'), 'utf8')

describe('the owner list in docs/hosted-pods.md', () => {
  const start = pods.indexOf('## What only a KVM host can settle')
  const end = pods.indexOf('\n## ', start + 5)
  const section = pods.slice(start, end)

  it('is the first section after the title, before Status', () => {
    assert.ok(start > 0)
    assert.ok(start < pods.indexOf('## Status'))
    assert.equal(pods.slice(0, start).split('\n## ').length, 1, 'no other section comes first')
  })

  it('is a single numbered list, 1 to N with no gaps', () => {
    const numbers = [...section.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]))
    assert.ok(numbers.length >= 7)
    assert.deepEqual(numbers, numbers.map((_, i) => i + 1))
  })

  it('every runbook section it cites exists, and the real test command is the runbook\'s', () => {
    const headings = new Set([...runbook.matchAll(/^## (\d+)\. /gm)].map((m) => m[1]))
    const cited = [...section.matchAll(/(?<!#185 )section (\d+)/g)].map((m) => m[1])
    assert.ok(cited.length >= 6)
    for (const n of cited) assert.ok(headings.has(n), `runbook section ${n}`)
    assert.match(section, /REQUIRE_REAL_FIRECRACKER=1 npm run test:real-firecracker/)
    assert.match(runbook, /REQUIRE_REAL_FIRECRACKER=1[\s\S]*npm run test:real-firecracker/)
  })
})

describe('the runbook stays exact', () => {
  it('every repository path it names exists', async () => {
    const missing = []
    const external = new Set(['docs/getting-started.md']) // Firecracker's own document, named as such
    for (const [, path] of runbook.matchAll(/`((?:spikes|docs|packages|design|scripts|test)\/[A-Za-z0-9_./-]+)`/g)) {
      if (external.has(path)) continue
      const candidates = [path, join('docs', path), join('spikes', 'vm-pod-host', path)]
      let found = false
      for (const candidate of candidates) {
        try { await access(join(ROOT, candidate)); found = true; break } catch { /* try the next */ }
      }
      if (!found) missing.push(path)
    }
    assert.deepEqual(missing, [])
  })

  it('every npm script it runs exists at the root', async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
    for (const [, name] of runbook.matchAll(/npm run ([a-z:-]+)/g)) assert.ok(pkg.scripts[name], name)
  })

  it('the rootfs section matches the build script on the Node versions and the knobs', async () => {
    const script = await readFile(join(ROOT, 'spikes', 'vm-pod-host', 'guest', 'build-rootfs.sh'), 'utf8')
    assert.match(script, /ALPINE_VERSION="\$\{ALPINE_VERSION:-3\.20\}"/)
    assert.match(runbook, /ALPINE_VERSION=3\.23/)
    assert.match(runbook, /20\.15\.1/)
  })
})
