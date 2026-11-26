// scripts/staggered-publish.sh is the release workflow's package list (the workflow runs it after the version
// pull request merges). A published package that is missing from it is never published; a private one in it
// would fail the release; a package listed before the packages it depends on would publish into a registry
// that cannot resolve it yet.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

async function workspacePackages() {
  const out = []
  for (const entry of await readdir(join(ROOT, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    out.push(JSON.parse(await readFile(join(ROOT, 'packages', entry.name, 'package.json'), 'utf8')))
  }
  return out
}

async function listedPackages() {
  const text = await readFile(join(ROOT, 'scripts', 'staggered-publish.sh'), 'utf8')
  return [...text.matchAll(/^\s*"(@johnhenry\/browsermesh-[a-z-]+)"/gm)].map((m) => m[1])
}

describe('scripts/staggered-publish.sh', () => {
  it('lists every public workspace package exactly once, and no private one', async () => {
    const listed = await listedPackages()
    const pkgs = await workspacePackages()
    const publicNames = pkgs.filter((p) => !p.private).map((p) => p.name).sort()
    assert.deepEqual([...listed].sort(), publicNames)
    assert.equal(new Set(listed).size, listed.length, 'a package is listed twice')
  })

  it('lists a package after every workspace package it installs as a dependency (peers may point both ways)', async () => {
    const listed = await listedPackages()
    const pkgs = await workspacePackages()
    const problems = []
    for (const pkg of pkgs.filter((p) => !p.private)) {
      for (const field of ['dependencies', 'optionalDependencies']) {
        for (const dep of Object.keys(pkg[field] ?? {})) {
          if (!listed.includes(dep)) continue
          if (listed.indexOf(dep) > listed.indexOf(pkg.name)) problems.push(`${pkg.name} (${field}) needs ${dep}, listed later`)
        }
      }
    }
    assert.deepEqual(problems, [])
  })

  it('does not state a package count that the list can drift from', async () => {
    const text = await readFile(join(ROOT, 'scripts', 'staggered-publish.sh'), 'utf8')
    assert.doesNotMatch(text, /\bpublish\w* (all )?\d+ packages\b/i)
    assert.doesNotMatch(text, /\$TOTAL\/\d+\]/)
  })
})
