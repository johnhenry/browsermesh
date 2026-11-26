/**
 * standalone.test.mjs -- the package as `npm pack` would ship it (its `files`:
 * src, bin, README, LICENSE) must start without the rest of the repository.
 *
 * `meshctl vm` folds in the vm-pod-host spike, which lives outside the package
 * (`spikes/vm-pod-host`, not a workspace member). That import used to be static,
 * so a package without a repository checkout beside it failed at load for EVERY
 * command. It is now loaded only for `meshctl vm`, which says what it needs.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT_NODE_MODULES = join(PACKAGE, '..', '..', 'node_modules')

describe('the package without its optional peers (transport and wsh are not installed)', () => {
  let dir
  let bin

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'meshctl-nopeers-'))
    const pkg = join(dir, 'package')
    for (const entry of ['src', 'bin', 'package.json']) await cp(join(PACKAGE, entry), join(pkg, entry), { recursive: true })
    // The repository's node_modules, minus the two optional peers.
    const modules = join(pkg, 'node_modules')
    await mkdir(join(modules, '@johnhenry'), { recursive: true })
    for (const entry of await readdir(ROOT_NODE_MODULES)) {
      if (entry !== '@johnhenry') await symlink(join(ROOT_NODE_MODULES, entry), join(modules, entry))
    }
    for (const entry of await readdir(join(ROOT_NODE_MODULES, '@johnhenry'))) {
      if (entry === 'browsermesh-transport' || entry === 'wsh') continue
      await symlink(join(ROOT_NODE_MODULES, '@johnhenry', entry), join(modules, '@johnhenry', entry))
    }
    bin = join(pkg, 'bin', 'meshctl.mjs')
  })

  after(async () => { await rm(dir, { recursive: true, force: true }) })

  it('starts, and runs a loopback command', async () => {
    assert.equal(JSON.parse((await run(process.execPath, [bin, '--help'])).stdout).result.name, 'meshctl')
    const { stdout } = await run(process.execPath, [bin, 'hosts', '--loopback', '--identity', join(dir, 'identity.json')])
    assert.equal(JSON.parse(stdout).ok, true)
  })

  it('--signaling and --wsh-relay say which package to install, as a usage error', async () => {
    for (const flags of [['--signaling', 'ws://127.0.0.1:1'], ['--wsh-relay', 'wss://127.0.0.1:1']]) {
      await assert.rejects(run(process.execPath, [bin, 'hosts', ...flags, '--identity', join(dir, 'identity.json')]), (err) => {
        assert.equal(err.code, 2, flags[0])
        const doc = JSON.parse(err.stderr.split('\n').find((l) => l.startsWith('{')))
        assert.equal(doc.error.code, 'EUSAGE')
        assert.match(doc.error.message, /@johnhenry\/browsermesh-transport/)
        assert.match(doc.error.message, /npm install/)
        return true
      })
    }
  })
})

describe('the package without a repository checkout around it', () => {
  let dir
  let bin

  before(async () => {
    // What `files` in package.json ships, in a directory with no `spikes/` anywhere above it.
    dir = await mkdtemp(join(tmpdir(), 'meshctl-standalone-'))
    const pkg = join(dir, 'package')
    for (const entry of ['src', 'bin', 'package.json']) await cp(join(PACKAGE, entry), join(pkg, entry), { recursive: true })
    await symlink(ROOT_NODE_MODULES, join(pkg, 'node_modules'))
    bin = join(pkg, 'bin', 'meshctl.mjs')
  })

  after(async () => { await rm(dir, { recursive: true, force: true }) })

  it('starts: --help exits 0 with its usage document', async () => {
    const { stdout } = await run(process.execPath, [bin, '--help'])
    assert.equal(JSON.parse(stdout).result.name, 'meshctl')
  })

  it('the commands that do not use the spike work: identity', async () => {
    const identityPath = join(dir, 'identity.json')
    const { stdout } = await run(process.execPath, [bin, 'identity', '--identity', identityPath])
    assert.equal(JSON.parse(stdout).ok, true)
  })

  it('`vm` says what it needs, as a usage error, instead of crashing', async () => {
    await assert.rejects(run(process.execPath, [bin, 'vm', 'status']), (err) => {
      assert.equal(err.code, 2)
      const line = err.stderr.split('\n').find((l) => l.startsWith('{'))
      const doc = JSON.parse(line)
      assert.equal(doc.error.code, 'EUSAGE')
      assert.match(doc.error.message, /spikes\/vm-pod-host/)
      assert.match(doc.error.message, /checkout/)
      return true
    })
  })
})
