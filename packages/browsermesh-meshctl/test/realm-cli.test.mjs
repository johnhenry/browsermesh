import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { runCli } from './helpers.mjs'
import { EXIT_CODE, exitCodeForError } from '../src/output.mjs'
import { realmFixture, PP } from './realm-helpers.mjs'

const run = promisify(execFile)
const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT_NODE_MODULES = join(PACKAGE, '..', '..', 'node_modules')

describe('realm in the usage document and the exit-code table', () => {
  it('--help lists every realm command and the store and passphrase flags', async () => {
    const { code, stdout } = await runCli(['--help'])
    assert.equal(code, 0)
    const doc = JSON.parse(stdout).result
    for (const c of ['create', 'issue', 'revoke', 'rotate', 'ledger', 'join', 'ls', 'inspect', 'export', 'invite']) {
      assert.ok(doc.commands.some((line) => line.startsWith(`realm ${c}`)), `realm ${c}`)
    }
    for (const flag of ['--realm-dir', '--passphrase-env', '--passphrase-file']) {
      assert.ok(Object.keys(doc.globalFlags).some((f) => f.startsWith(flag)), flag)
    }
    assert.ok(!Object.keys(doc.globalFlags).some((f) => f.startsWith('--passphrase ') || f === '--passphrase'), 'no --passphrase flag')
    assert.deepEqual(doc.exitCodes, EXIT_CODE)
  })

  it('the realm error codes map onto the existing exit codes', () => {
    const table = {
      EREALM_NOT_IMPLEMENTED: EXIT_CODE.USAGE,
      EREALM_BAD_PASSPHRASE: EXIT_CODE.EACCES,
      EREALM_PASSPHRASE_FILE_MODE: EXIT_CODE.EACCES,
      EREALM_NO_KEY: EXIT_CODE.EACCES,
      EREALM_NOT_FOUND: EXIT_CODE.ENOENT,
      EREALM_VERIFY: EXIT_CODE.GENERIC,
      EREALM_EXISTS: EXIT_CODE.GENERIC,
    }
    for (const [code, exit] of Object.entries(table)) assert.equal(exitCodeForError(code), exit, code)
  })

  it('realm needs a subcommand, and an unknown one is a usage error', async () => {
    for (const argv of [['realm'], ['realm', 'bogus']]) {
      const { code, stderr } = await runCli(argv)
      assert.equal(code, 2)
      assert.equal(JSON.parse(stderr).error.code, 'EUSAGE')
    }
  })
})

describe('realm invite (tickets and admitters are not in v1)', () => {
  let fx
  before(async () => { fx = await realmFixture() })
  after(async () => { await fx.cleanup() })

  it('exits 2 with a stable code and points at key-bound issue', async () => {
    const created = await fx.ok(['realm', 'create', 'club', ...PP])
    for (const argv of [['realm', 'invite', created.realm.id, '--role', 'member', '--uses', '1'], ['realm', 'invite']]) {
      const r = await fx.run(argv)
      assert.equal(r.code, 2)
      assert.equal(r.stdout, '')
      assert.equal(r.error.code, 'EREALM_NOT_IMPLEMENTED')
      assert.match(r.error.message, /not implemented in v1/)
      assert.match(r.error.message, /realm issue/)
    }
  })
})

describe('without @johnhenry/browsermesh-realm installed', () => {
  let dir
  let bin

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'meshctl-norealm-'))
    const pkg = join(dir, 'package')
    for (const entry of ['src', 'bin', 'package.json']) await cp(join(PACKAGE, entry), join(pkg, entry), { recursive: true })
    const modules = join(pkg, 'node_modules')
    await mkdir(join(modules, '@johnhenry'), { recursive: true })
    for (const entry of await readdir(ROOT_NODE_MODULES)) {
      if (entry !== '@johnhenry') await symlink(join(ROOT_NODE_MODULES, entry), join(modules, entry))
    }
    for (const entry of await readdir(join(ROOT_NODE_MODULES, '@johnhenry'))) {
      if (entry === 'browsermesh-realm') continue
      await symlink(join(ROOT_NODE_MODULES, '@johnhenry', entry), join(modules, '@johnhenry', entry))
    }
    bin = join(pkg, 'bin', 'meshctl.mjs')
  })
  after(async () => { await rm(dir, { recursive: true, force: true }) })

  it('the realm commands say what to install, as a usage error', async () => {
    for (const argv of [['realm', 'ls'], ['realm', 'create', 'x', '--authority-less']]) {
      await assert.rejects(run(process.execPath, [bin, ...argv, '--realm-dir', join(dir, 'realms')]), (err) => {
        assert.equal(err.code, 2, argv.join(' '))
        const doc = JSON.parse(err.stderr.split('\n').find((l) => l.startsWith('{')))
        assert.equal(doc.error.code, 'EUSAGE')
        assert.match(doc.error.message, /the realm commands need @johnhenry\/browsermesh-realm: npm install @johnhenry\/browsermesh-realm/)
        return true
      })
    }
  })

  it('every other command still works, and so does realm invite', async () => {
    const help = JSON.parse((await run(process.execPath, [bin, '--help'])).stdout)
    assert.equal(help.result.name, 'meshctl')
    const hosts = await run(process.execPath, [bin, 'hosts', '--loopback', '--identity', join(dir, 'identity.json')])
    assert.equal(JSON.parse(hosts.stdout).ok, true)
    await assert.rejects(run(process.execPath, [bin, 'realm', 'invite']), (err) => {
      assert.equal(err.code, 2)
      const doc = JSON.parse(err.stderr.split('\n').find((l) => l.startsWith('{')))
      assert.equal(doc.error.code, 'EREALM_NOT_IMPLEMENTED')
      return true
    })
  })
})
