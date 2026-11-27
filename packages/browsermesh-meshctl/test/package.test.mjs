/**
 * package.test.mjs -- the package is publishable: its manifest, what `npm pack` ships, and a README that tells a
 * user what is and is not there. (Starting without a repository checkout is `standalone.test.mjs`.)
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(join(PACKAGE, 'package.json'), 'utf8'))
const readme = await readFile(join(PACKAGE, 'README.md'), 'utf8')

describe('the manifest', () => {
  it('is public, scoped, MIT, and published with public access', () => {
    assert.equal(pkg.name, '@johnhenry/browsermesh-meshctl')
    assert.ok(!('private' in pkg), 'private is removed')
    assert.equal(pkg.license, 'MIT')
    assert.equal(pkg.publishConfig?.access, 'public')
    assert.equal(pkg.repository?.url, 'https://github.com/johnhenry/browsermesh')
    assert.equal(pkg.repository?.directory, 'packages/browsermesh-meshctl')
    assert.equal(pkg.engines?.node, '>=26.0.0')
  })

  it('has a bin that points at a file with a node shebang', async () => {
    assert.deepEqual(pkg.bin, { meshctl: './bin/meshctl.mjs' })
    const text = await readFile(join(PACKAGE, 'bin', 'meshctl.mjs'), 'utf8')
    assert.ok(text.startsWith('#!/usr/bin/env node\n'))
    assert.ok(((await stat(join(PACKAGE, 'bin', 'meshctl.mjs'))).mode & 0o111) !== 0, 'the bin is executable')
  })

  it('ships src, bin, LICENSE and README only', () => {
    assert.deepEqual([...pkg.files].sort(), ['LICENSE', 'README.md', 'bin', 'src'])
  })

  it('needs the transport release that has the /wsh subpath, optionally, and wsh optionally', () => {
    const [, low] = /^>=(\d+\.\d+\.\d+)/.exec(pkg.peerDependencies['@johnhenry/browsermesh-transport'])
    const [major, minor] = low.split('.').map(Number)
    assert.ok(major > 0 || minor >= 11, `transport peer ${low} has /wsh`)
    assert.equal(pkg.peerDependenciesMeta['@johnhenry/browsermesh-transport'].optional, true)
    assert.ok(pkg.peerDependencies['@johnhenry/wsh'])
    assert.equal(pkg.peerDependenciesMeta['@johnhenry/wsh'].optional, true)
  })

  it('keeps the realm package an optional peer (a separate published package) and depends on keyvault for key custody', () => {
    assert.ok(pkg.peerDependencies['@johnhenry/browsermesh-realm'])
    assert.equal(pkg.peerDependenciesMeta['@johnhenry/browsermesh-realm'].optional, true)
    assert.ok(pkg.devDependencies['@johnhenry/browsermesh-realm'], 'a workspace devDependency so the tests run')
    assert.ok(pkg.dependencies['@johnhenry/keyvault'])
    assert.ok(!('@johnhenry/browsermesh-realm' in (pkg.dependencies ?? {})))
  })

  it('asks for an apps release that has the placement planner it calls', () => {
    const [, low] = /^>=(\d+\.\d+\.\d+)/.exec(pkg.peerDependencies['@johnhenry/browsermesh-apps'])
    assert.ok(Number(low.split('.')[1]) >= 18, `apps peer ${low}`)
  })
})

describe('what npm pack ships', () => {
  it('is the source, the bin, the README and the licence, and no test or spike', async () => {
    const cache = await mkdtemp(join(tmpdir(), 'meshctl-pack-'))
    try {
      const { stdout } = await run('npm', ['pack', '--dry-run', '--json', '--cache', join(cache, 'cache'), '--userconfig', join(cache, 'npmrc')], { cwd: PACKAGE })
      const files = JSON.parse(stdout)[0].files.map((f) => f.path)
      for (const f of ['LICENSE', 'README.md', 'package.json', 'bin/meshctl.mjs', 'src/cli.mjs', 'src/index.mjs']) assert.ok(files.includes(f), f)
      assert.deepEqual(files.filter((f) => !/^(src\/|bin\/|LICENSE$|README\.md$|package\.json$)/.test(f)), [])
    } finally {
      await rm(cache, { recursive: true, force: true })
    }
  })
})

describe('the README', () => {
  it('is written for a user: install, commands, transports, and what is not supported', () => {
    for (const heading of ['## Install', '## Commands', '## Transports', '## What is not supported']) assert.ok(readme.includes(`\n${heading}\n`), heading)
    assert.match(readme, /npm install -g @johnhenry\/browsermesh-meshctl/)
    assert.match(readme, /--wsh-relay/)
    assert.match(readme, /--signaling/)
    assert.match(readme, /--loopback/)
  })

  it('documents the realm commands, key custody, and the limits it states plainly', () => {
    assert.ok(readme.includes('\n## Realms\n'))
    const flat = readme.replace(/\s*\n>?\s*/g, ' ')
    assert.match(flat, /--passphrase-env/)
    assert.match(flat, /--passphrase-file/)
    assert.match(flat, /cannot list (the )?live peers/i)
    assert.match(flat, /There is no `realm leave`/)
    assert.match(flat, /local key custody and offline signing/)
    assert.match(flat, /seed/i)
  })

  it('says `vm` needs a repository checkout, and does not call the package private or unpublished', () => {
    assert.match(readme, /`vm`[^\n]*(needs|requires)[^\n]*checkout/i)
    assert.doesNotMatch(readme, /"private": true/)
    assert.doesNotMatch(readme, /not published yet/i)
    assert.doesNotMatch(readme, /private, not yet published/i)
  })

  it('says what the one real run covered, and what has still not been run', () => {
    // Line wraps and blockquote markers are not part of the claim.
    const flat = readme.replace(/\s*\n>?\s*/g, ' ')
    assert.match(flat, /been run once against a deployed pod host over `--wsh-relay`/i)
    assert.match(flat, /not been run against a host backed by a real VMM or isolate runtime, nor over `--signaling`/i)
  })
})
