import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { verifyDescriptor, verifyAuthorityless } from '@johnhenry/browsermesh-realm'
import { realmFixture, PP, PASSPHRASE } from './realm-helpers.mjs'

const modeOf = async (p) => (await stat(p)).mode & 0o777

describe('realm create', () => {
  let fx
  before(async () => { fx = await realmFixture() })
  after(async () => { await fx.cleanup() })

  it('creates an invite realm: a root-signed descriptor that verifies against its own id, plus sealed keys', async () => {
    const res = await fx.ok(['realm', 'create', 'garden', ...PP, '--ttl', '2d'])
    assert.equal(res.realm.name, 'garden')
    assert.equal(res.realm.mode, 'invite')
    assert.equal(res.realm.form, 'signed')
    assert.equal(res.realm.serial, 1)
    assert.equal(res.realm.epoch, 0)
    assert.equal(res.realm.ttl, 2 * 86400)
    assert.equal(typeof res.descriptor, 'string')
    assert.ok(res.root.publicKey && res.issuer.publicKey && res.root.publicKey !== res.issuer.publicKey)

    const v = await verifyDescriptor(res.descriptor, { pinnedId: res.realm.id })
    assert.equal(v.ok, true, JSON.stringify(v))
    assert.equal(v.descriptor.root.key, res.root.publicKey)
    assert.deepEqual(v.descriptor.issuers.map((i) => i.key), [res.issuer.publicKey])
    assert.equal(v.descriptor.mode, 'invite')
  })

  it('stores everything under <realm-dir>/<id>, owner-only (0700 dir, 0600 files)', async () => {
    const res = await fx.ok(['realm', 'create', 'perms', ...PP])
    const dir = join(fx.realmDir, res.realm.id)
    assert.equal(await modeOf(dir), 0o700)
    const entries = await readdir(dir, { recursive: true, withFileTypes: true })
    assert.ok(entries.length >= 3)
    for (const f of entries) {
      const p = join(f.parentPath, f.name)
      assert.equal(await modeOf(p), f.isDirectory() ? 0o700 : 0o600, p)
    }
    assert.equal(await readFile(join(dir, 'descriptor.json'), 'utf8'), res.descriptor)
  })

  it('seals the root and issuer keys: no plaintext key material, and the passphrase is nowhere on disk or in output', async () => {
    const res = await fx.ok(['realm', 'create', 'sealed', ...PP])
    const dir = join(fx.realmDir, res.realm.id)
    for (const file of [res.root.file, res.issuer.file]) {
      const text = await readFile(join(dir, file), 'utf8')
      const rec = JSON.parse(text)
      assert.equal(rec.t, 'browsermesh-realm-root')
      assert.equal(rec.v, 1)
      assert.ok(rec.ct && rec.iv && rec.kdf?.salt)
      assert.equal(rec.d, undefined)
      assert.equal(rec.privateKeyJwk, undefined)
      assert.doesNotMatch(text, /PRIVATE|"d"\s*:/)
    }
    const everything = []
    for (const f of await readdir(dir, { recursive: true, withFileTypes: true })) {
      if (f.isFile()) everything.push(await readFile(join(f.parentPath, f.name), 'utf8'))
    }
    assert.doesNotMatch(everything.join('\n'), new RegExp(PASSPHRASE))
    assert.doesNotMatch(fx.seen.join('\n'), new RegExp(PASSPHRASE))
  })

  it('an open realm still has a root and an issuer, and the guest role is the default', async () => {
    const res = await fx.ok(['realm', 'create', 'plaza', '--mode', 'open', ...PP])
    assert.equal(res.realm.mode, 'open')
    const v = await verifyDescriptor(res.descriptor, { pinnedId: res.realm.id })
    assert.equal(v.ok, true)
    assert.ok(v.descriptor.roles.guest)
  })

  it('--rendezvous and --roles take inline JSON or a file', async () => {
    const rendezvous = { signaling: ['wss://sig.example/ws'], relays: ['wss://relay.example/pipe'], ice: [], bootstrap: [] }
    const roles = { guest: ['protocol:mcp:open'], steward: ['mcp:tool:call'] }
    const res = await fx.ok(['realm', 'create', 'wired', ...PP, '--rendezvous', JSON.stringify(rendezvous), '--roles', JSON.stringify(roles)])
    const v = await verifyDescriptor(res.descriptor, { pinnedId: res.realm.id })
    assert.deepEqual(v.descriptor.rendezvous, rendezvous)
    assert.deepEqual(Object.keys(v.descriptor.roles).sort(), ['guest', 'steward'])

    const file = join(fx.dir, 'rendezvous.json')
    await writeFile(file, JSON.stringify(rendezvous))
    const res2 = await fx.ok(['realm', 'create', 'wired-file', ...PP, '--rendezvous', file])
    assert.deepEqual((await verifyDescriptor(res2.descriptor, { pinnedId: res2.realm.id })).descriptor.rendezvous, rendezvous)
  })

  it('--authority-less needs no passphrase, has no root or issuer, and carries only guest', async () => {
    const res = await fx.ok(['realm', 'create', 'commons', '--authority-less'], { env: { MESHCTL_TEST_PP: undefined } })
    assert.equal(res.realm.form, 'authorityless')
    assert.equal(res.realm.mode, 'open')
    assert.equal(res.root, null)
    assert.equal(res.issuer, null)
    const v = await verifyAuthorityless(res.descriptor, { pinnedId: res.realm.id })
    assert.equal(v.ok, true, JSON.stringify(v))
    const files = await readdir(join(fx.realmDir, res.realm.id))
    assert.deepEqual(files.filter((f) => /key/.test(f)), [])
  })

  it('--authority-less with --mode invite is a usage error', async () => {
    const r = await fx.run(['realm', 'create', 'x', '--authority-less', '--mode', 'invite'])
    assert.equal(r.code, 2)
    assert.equal(r.error.code, 'EUSAGE')
  })

  it('refuses a bad mode, a missing name and a ttl out of range as usage errors', async () => {
    for (const argv of [['realm', 'create', 'x', '--mode', 'closed', ...PP], ['realm', 'create', ...PP], ['realm', 'create', 'x', '--ttl', '5', ...PP], ['realm', 'create', 'x', '--ttl', 'soon', ...PP]]) {
      const r = await fx.run(argv)
      assert.equal(r.code, 2, argv.join(' '))
      assert.equal(r.error.code, 'EUSAGE')
    }
  })

  it('does not create a realm twice under the same id', async () => {
    // The authority-less id hashes name, roles and salt; a fixed salt makes the id repeat.
    const salt = 'AAAAAAAAAAAAAAAAAAAAAA'
    const b = await fx.run(['realm', 'create', 'two', '--authority-less', '--salt', salt])
    const c = await fx.run(['realm', 'create', 'two', '--authority-less', '--salt', salt])
    assert.equal(b.code, 0)
    assert.equal(c.code, 1)
    assert.equal(c.error.code, 'EREALM_EXISTS')
  })
})
