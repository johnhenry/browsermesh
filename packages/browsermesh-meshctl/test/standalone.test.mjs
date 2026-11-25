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
import { cp, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT_NODE_MODULES = join(PACKAGE, '..', '..', 'node_modules')

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
