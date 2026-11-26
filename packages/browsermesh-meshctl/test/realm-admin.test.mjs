import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { verifyDescriptor, verifyCredential, adoptDescriptor, importLedger } from '@johnhenry/browsermesh-realm'
import { realmFixture, PP, freshKey } from './realm-helpers.mjs'

describe('realm issue', () => {
  let fx
  let created
  before(async () => {
    fx = await realmFixture()
    created = await fx.ok(['realm', 'create', 'club', ...PP])
  })
  after(async () => { await fx.cleanup() })

  it('issues a key-bound credential that verifies against the descriptor, and says so', async () => {
    const key = await freshKey()
    const res = await fx.ok(['realm', 'issue', created.realm.id, '--role', 'member', '--key', key, '--ttl', '1d', ...PP])
    assert.equal(res.realm, created.realm.id)
    assert.equal(res.subject, key)
    assert.equal(res.role, 'member')
    assert.equal(res.epoch, 0)
    assert.equal(res.serial, 1)
    assert.equal(res.issuer, created.issuer.publicKey)
    assert.equal(res.verified, true)
    assert.equal(res.notAfter - res.notBefore, 86400)
    assert.ok(Number.isInteger(res.notBefore) && Number.isInteger(res.notAfter), 'whole seconds')
    const v = await verifyDescriptor(created.descriptor, { pinnedId: created.realm.id })
    const c = await verifyCredential(res.credential, v.descriptor)
    assert.equal(c.ok, true, JSON.stringify(c))
    assert.equal(c.credential.subject, key)
  })

  it('defaults the lifetime to the realm ttl, allocates serials from one ledger, and records them', async () => {
    const a = await fx.ok(['realm', 'issue', created.realm.id, '--role', 'member', '--key', await freshKey(), ...PP])
    const b = await fx.ok(['realm', 'issue', created.realm.id, '--role', 'guest', '--key', await freshKey(), ...PP])
    assert.equal(a.notAfter - a.notBefore, 7 * 86400)
    assert.equal(b.serial, a.serial + 1)
    const led = await fx.ok(['realm', 'ledger', created.realm.id])
    assert.equal(led.realm, created.realm.id)
    assert.ok(led.entries.some((e) => e.serial === a.serial && e.state === 'issued' && e.subject === a.subject))
    assert.equal(led.nextSerial, b.serial + 1)
    assert.deepEqual(led.revoked, [])
    const onDisk = importLedger(await readFile(join(fx.realmDir, created.realm.id, 'ledger.json'), 'utf8'))
    assert.equal(onDisk.nextSerial, led.nextSerial)
  })

  it('--out writes the credential text', async () => {
    const out = join(fx.dir, 'cred.json')
    const res = await fx.ok(['realm', 'issue', created.realm.id, '--role', 'member', '--key', await freshKey(), '--out', out, ...PP])
    assert.equal(await readFile(out, 'utf8'), res.credential)
  })

  it('refuses a bad key, an undefined role, a lifetime past the realm ttl, and an unknown realm', async () => {
    const key = await freshKey()
    const cases = [
      [['--role', 'member', '--key', 'not-a-key'], 2],
      [['--role', 'wizard', '--key', key], 2],
      [['--role', 'member'], 2],
      [['--role', 'member', '--key', key, '--ttl', '60d'], 2],
    ]
    for (const [extra, code] of cases) {
      const r = await fx.run(['realm', 'issue', created.realm.id, ...extra, ...PP])
      assert.equal(r.code, code, extra.join(' '))
      assert.equal(r.error.code, 'EUSAGE')
    }
    const r = await fx.run(['realm', 'issue', 'no-such-realm-at-all', '--role', 'member', '--key', key, ...PP])
    assert.equal(r.code, 4)
    assert.equal(r.error.code, 'EREALM_NOT_FOUND')
  })

  it('a failed issue does not burn a serial', async () => {
    const before = (await fx.ok(['realm', 'ledger', created.realm.id])).nextSerial
    await fx.run(['realm', 'issue', created.realm.id, '--role', 'wizard', '--key', await freshKey(), ...PP])
    assert.equal((await fx.ok(['realm', 'ledger', created.realm.id])).nextSerial, before)
  })

  it('issuing needs only the issuer key: it works with the root key moved away', async () => {
    const r2 = await fx.ok(['realm', 'create', 'cold-root', ...PP])
    await rm(join(fx.realmDir, r2.realm.id, r2.root.file))
    const ok = await fx.run(['realm', 'issue', r2.realm.id, '--role', 'member', '--key', await freshKey(), ...PP])
    assert.equal(ok.code, 0, ok.stderr)
    const revoke = await fx.run(['realm', 'revoke', r2.realm.id, '--epoch', ...PP])
    assert.equal(revoke.code, 3)
    assert.equal(revoke.error.code, 'EREALM_NO_KEY')
  })
})

describe('realm revoke', () => {
  let fx
  let created
  let cred
  let before1
  before(async () => {
    fx = await realmFixture()
    created = await fx.ok(['realm', 'create', 'club', ...PP])
    cred = await fx.ok(['realm', 'issue', created.realm.id, '--role', 'member', '--key', await freshKey(), ...PP])
    before1 = created.descriptor
  })
  after(async () => { await fx.cleanup() })

  it('--serial puts the serial in descriptor.revoked and re-signs at serial+1', async () => {
    const res = await fx.ok(['realm', 'revoke', created.realm.id, '--serial', String(cred.serial), ...PP])
    assert.equal(res.action, 'serial')
    assert.equal(res.serial, cred.serial)
    assert.equal(res.descriptorSerial, 2)
    assert.deepEqual(res.revoked, [cred.serial])
    const v = await verifyDescriptor(res.descriptor, { pinnedId: created.realm.id })
    assert.equal(v.ok, true, JSON.stringify(v))
    assert.equal(v.descriptor.serial, 2)
    assert.deepEqual(v.descriptor.revoked, [cred.serial])
    assert.equal(v.descriptor.epoch, 0)
    const old = await verifyDescriptor(before1, { pinnedId: created.realm.id })
    assert.equal((await verifyCredential(cred.credential, old.descriptor)).ok, true)
    const after = await verifyCredential(cred.credential, v.descriptor)
    assert.deepEqual([after.ok, after.reason], [false, 'revoked'])
    const adopted = await adoptDescriptor(old.descriptor, res.descriptor, { pinnedId: created.realm.id })
    assert.equal(adopted.ok, true)
    assert.equal(await readFile(join(fx.realmDir, created.realm.id, 'descriptor.json'), 'utf8'), res.descriptor)
    const led = await fx.ok(['realm', 'ledger', created.realm.id])
    assert.equal(led.entries.find((e) => e.serial === cred.serial).state, 'revoked')
    assert.deepEqual(led.revoked, [cred.serial])
  })

  it('revoking an unknown serial is ENOENT and changes nothing', async () => {
    const r = await fx.run(['realm', 'revoke', created.realm.id, '--serial', '999', ...PP])
    assert.equal(r.code, 4)
    assert.equal(r.error.code, 'ENOENT')
  })

  it('--epoch bumps the epoch and raises the serial; credentials of the old epoch stop verifying', async () => {
    const live = await fx.ok(['realm', 'issue', created.realm.id, '--role', 'member', '--key', await freshKey(), ...PP])
    const res = await fx.ok(['realm', 'revoke', created.realm.id, '--epoch', ...PP])
    assert.equal(res.action, 'epoch')
    assert.equal(res.epoch, 1)
    assert.equal(res.descriptorSerial, 3)
    const v = await verifyDescriptor(res.descriptor, { pinnedId: created.realm.id })
    assert.equal(v.ok, true)
    assert.equal(v.descriptor.epoch, 1)
    const stale = await verifyCredential(live.credential, v.descriptor)
    assert.deepEqual([stale.ok, stale.reason], [false, 'epoch-too-old'])
    const fresh = await fx.ok(['realm', 'issue', created.realm.id, '--role', 'member', '--key', await freshKey(), ...PP])
    assert.equal(fresh.epoch, 1)
    assert.equal((await verifyCredential(fresh.credential, v.descriptor)).ok, true)
  })

  it('needs exactly one of --serial and --epoch', async () => {
    for (const extra of [[], ['--serial', '1', '--epoch'], ['--serial', 'x']]) {
      const r = await fx.run(['realm', 'revoke', created.realm.id, ...extra, ...PP])
      assert.equal(r.code, 2, extra.join(' '))
    }
  })
})

describe('realm rotate', () => {
  let fx
  let created
  before(async () => {
    fx = await realmFixture()
    created = await fx.ok(['realm', 'create', 'turning', ...PP])
  })
  after(async () => { await fx.cleanup() })

  it('produces a new root, a rotation chain a fresh verifier accepts, and the same realm id', async () => {
    const cred = await fx.ok(['realm', 'issue', created.realm.id, '--role', 'member', '--key', await freshKey(), ...PP])
    const res = await fx.ok(['realm', 'rotate', created.realm.id, ...PP])
    assert.equal(res.realm, created.realm.id)
    assert.equal(res.descriptorSerial, 2)
    assert.equal(res.chainLength, 1)
    assert.equal(res.root.previous, created.root.publicKey)
    assert.notEqual(res.root.publicKey, created.root.publicKey)
    // A verifier that knows only the pinned id and the new text.
    const v = await verifyDescriptor(res.descriptor, { pinnedId: created.realm.id })
    assert.equal(v.ok, true, JSON.stringify(v))
    assert.equal(v.chainLength, 1)
    assert.equal(v.descriptor.root.key, res.root.publicKey)
    assert.equal(v.descriptor.root.chain[0].from, created.root.publicKey)
    // The issuer is unchanged, so a credential issued before the rotation still verifies.
    assert.equal((await verifyCredential(cred.credential, v.descriptor)).ok, true)
    // A peer holding the old descriptor adopts the new one.
    const old = await verifyDescriptor(created.descriptor, { pinnedId: created.realm.id })
    assert.equal((await adoptDescriptor(old.descriptor, res.descriptor, { pinnedId: created.realm.id })).ok, true)
  })

  it('replaces the sealed root: the old key file is gone, the new one matches the descriptor', async () => {
    const dir = join(fx.realmDir, created.realm.id)
    const rec = JSON.parse(await readFile(join(dir, created.root.file), 'utf8'))
    assert.equal(rec.t, 'browsermesh-realm-root')
    assert.notEqual(rec.publicKey, created.root.publicKey)
    const insp = await fx.ok(['realm', 'inspect', created.realm.id])
    assert.equal(insp.custody.root.publicKey, rec.publicKey)
    assert.equal((await readdir(dir)).filter((f) => /key/.test(f)).length, 2)
  })

  it('can rotate again (chain of two), and the new root can still revoke', async () => {
    const res = await fx.ok(['realm', 'rotate', created.realm.id, ...PP])
    assert.equal(res.chainLength, 2)
    assert.equal(res.descriptorSerial, 3)
    assert.equal((await verifyDescriptor(res.descriptor, { pinnedId: created.realm.id })).ok, true)
    const rev = await fx.ok(['realm', 'revoke', created.realm.id, '--epoch', ...PP])
    const v = await verifyDescriptor(rev.descriptor, { pinnedId: created.realm.id })
    assert.equal(v.ok, true, JSON.stringify(v))
    assert.equal(v.chainLength, 2)
  })

  it('refuses a realm with no authority (authority-less) as a usage error', async () => {
    const al = await fx.ok(['realm', 'create', 'bare', '--authority-less'])
    for (const cmd of ['rotate', 'revoke']) {
      const r = await fx.run(['realm', cmd, al.realm.id, '--epoch', ...PP])
      assert.equal(r.code, 2, cmd)
    }
    const issue = await fx.run(['realm', 'issue', al.realm.id, '--role', 'guest', '--key', await freshKey(), ...PP])
    assert.equal(issue.code, 2)
  })

  it('a wrong passphrase leaves the realm untouched', async () => {
    const before = await readFile(join(fx.realmDir, created.realm.id, 'descriptor.json'), 'utf8')
    const r = await fx.run(['realm', 'rotate', created.realm.id, ...PP], { env: { MESHCTL_TEST_PP: 'wrong wrong wrong' } })
    assert.equal(r.code, 3)
    assert.equal(await readFile(join(fx.realmDir, created.realm.id, 'descriptor.json'), 'utf8'), before)
    assert.ok((await stat(join(fx.realmDir, created.realm.id, created.root.file))).isFile())
  })
})
