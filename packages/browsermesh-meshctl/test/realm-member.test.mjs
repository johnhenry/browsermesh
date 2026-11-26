import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { verifyDescriptor, verifyCredential, checkSubject } from '@johnhenry/browsermesh-realm'
import { realmFixture, PP, freshKey } from './realm-helpers.mjs'

const modeOf = async (p) => (await stat(p)).mode & 0o777

describe('realm join, ls, inspect, export (a member machine)', () => {
  let fx
  let admin
  let memberDir
  let created
  const member = (argv, opts) => fx.run(argv, { ...opts, realmDir: memberDir })
  const memberOk = async (argv) => {
    const r = await member(argv)
    if (r.code !== 0) throw new Error(`${argv.join(' ')}: ${r.stderr}`)
    return r.result
  }

  before(async () => {
    fx = await realmFixture()
    admin = fx.realmDir
    memberDir = join(fx.dir, 'member-realms')
    created = await fx.ok(['realm', 'create', 'club', ...PP])
  })
  after(async () => { await fx.cleanup() })

  it('join stores the verified descriptor and makes an independent per-realm identity (0600, in a 0700 dir)', async () => {
    const res = await memberOk(['realm', 'join', created.descriptor])
    assert.equal(res.realm.id, created.realm.id)
    assert.equal(res.adopted, true)
    assert.equal(res.pinned, 'computed')
    assert.equal(res.credential, null)
    assert.equal(res.identity.created, true)
    assert.ok(res.identity.podId && res.identity.publicKey)
    const dir = join(memberDir, created.realm.id)
    assert.equal(await readFile(join(dir, 'descriptor.json'), 'utf8'), created.descriptor)
    assert.equal(await modeOf(dir), 0o700)
    const idFile = join(dir, res.identity.file)
    assert.equal(await modeOf(idFile), 0o600)
    assert.equal(JSON.parse(await readFile(idFile, 'utf8')).podId, res.identity.podId)
    assert.deepEqual((await readdir(dir)).filter((f) => /root|issuer/.test(f)), [])
  })

  it('joining again keeps the identity and reports no change', async () => {
    const first = (await memberOk(['realm', 'inspect', created.realm.id])).profile.identity
    const again = await memberOk(['realm', 'join', created.descriptor, '--id', created.realm.id])
    assert.equal(again.pinned, 'given')
    assert.equal(again.adopted, false)
    assert.equal(again.identity.created, false)
    assert.equal(again.identity.podId, first.podId)
  })

  it('two realms get different identities', async () => {
    const other = await fx.ok(['realm', 'create', 'other-club', ...PP])
    const a = await memberOk(['realm', 'join', other.descriptor])
    const b = (await memberOk(['realm', 'inspect', created.realm.id])).profile.identity
    assert.notEqual(a.identity.podId, b.podId)
    assert.notEqual(a.identity.publicKey, b.publicKey)
  })

  it('join reads a descriptor file as well as inline text', async () => {
    const file = join(fx.dir, 'club.descriptor.json')
    await writeFile(file, `${created.descriptor}\n`)
    const dir2 = join(fx.dir, 'member-2')
    const r = await fx.run(['realm', 'join', file], { realmDir: dir2 })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(await readFile(join(dir2, created.realm.id, 'descriptor.json'), 'utf8'), created.descriptor)
    const missing = await fx.run(['realm', 'join', join(fx.dir, 'nope.json')], { realmDir: dir2 })
    assert.equal(missing.code, 4)
    assert.equal(missing.error.code, 'ENOENT')
  })

  it('join stores a credential issued to this realm identity, after verifying it and its subject', async () => {
    const inspect = await memberOk(['realm', 'inspect', created.realm.id])
    const mine = inspect.profile.identity.publicKey
    const issued = await fx.ok(['realm', 'issue', created.realm.id, '--role', 'member', '--key', mine, ...PP])
    const file = join(fx.dir, 'mine.cred.json')
    await writeFile(file, issued.credential)
    const res = await memberOk(['realm', 'join', created.descriptor, '--credential', file])
    assert.equal(res.credential.serial, issued.serial)
    assert.equal(res.credential.role, 'member')
    assert.equal(res.credential.verified, true)
    assert.equal(await modeOf(join(memberDir, created.realm.id, res.credential.file)), 0o600)
    const v = await verifyDescriptor(created.descriptor, { pinnedId: created.realm.id })
    const c = await verifyCredential(issued.credential, v.descriptor)
    assert.equal(checkSubject(c, mine).ok, true)
    const insp = await memberOk(['realm', 'inspect', created.realm.id])
    assert.equal(insp.profile.credentials.length, 1)
    assert.equal(insp.profile.credentials[0].serial, issued.serial)
    assert.equal(insp.profile.credentials[0].valid, true)
  })

  it('export --credential returns the stored credential; --descriptor (the default) returns the descriptor; never a key', async () => {
    const insp = await memberOk(['realm', 'inspect', created.realm.id])
    const serial = insp.profile.credentials[0].serial
    const c = await memberOk(['realm', 'export', created.realm.id, '--credential', String(serial)])
    assert.equal(c.serial, serial)
    assert.equal(JSON.parse(c.credential).role, 'member')
    const d = await memberOk(['realm', 'export', created.realm.id, '--descriptor'])
    assert.equal(d.descriptor, created.descriptor)
    assert.equal((await memberOk(['realm', 'export', created.realm.id])).descriptor, created.descriptor)
    const missing = await member(['realm', 'export', created.realm.id, '--credential', '4242'])
    assert.equal(missing.code, 4)
    const both = await member(['realm', 'export', created.realm.id, '--descriptor', '--credential', String(serial)])
    assert.equal(both.code, 2)
    // On the admin machine too: only the descriptor and issued credentials, never the sealed keys.
    const a = await fx.ok(['realm', 'export', created.realm.id])
    assert.deepEqual(Object.keys(a).sort(), ['descriptor', 'realm'])
    assert.doesNotMatch(JSON.stringify(a), /"ct"|browsermesh-realm-root/)
    const out = join(fx.dir, 'exported.json')
    await fx.ok(['realm', 'export', created.realm.id, '--out', out])
    assert.equal(await readFile(out, 'utf8'), created.descriptor)
  })

  it('refuses a credential issued to some other key', async () => {
    const issued = await fx.ok(['realm', 'issue', created.realm.id, '--role', 'member', '--key', await freshKey(), ...PP])
    const file = join(fx.dir, 'theirs.cred.json')
    await writeFile(file, issued.credential)
    const r = await member(['realm', 'join', created.descriptor, '--credential', file])
    assert.equal(r.code, 1)
    assert.equal(r.error.code, 'EREALM_VERIFY')
    assert.match(r.error.message, /subject/)
  })

  it('refuses a descriptor for another realm id (--id), and one that does not verify', async () => {
    const other = await fx.ok(['realm', 'create', 'imposter', ...PP])
    const wrongId = await member(['realm', 'join', other.descriptor, '--id', created.realm.id])
    assert.equal(wrongId.code, 1)
    assert.equal(wrongId.error.code, 'EREALM_VERIFY')
    assert.match(wrongId.error.message, /wrong-realm/)

    const tampered = created.descriptor.replace('"name":"club"', '"name":"clum"')
    assert.notEqual(tampered, created.descriptor)
    const dir3 = join(fx.dir, 'member-3')
    const r = await fx.run(['realm', 'join', tampered], { realmDir: dir3 })
    assert.equal(r.code, 1)
    assert.equal(r.error.code, 'EREALM_VERIFY')
    assert.match(r.error.message, /bad-signature/)
    await assert.rejects(readdir(dir3), { code: 'ENOENT' }, 'nothing is stored for a refused descriptor')

    const junk = await fx.run(['realm', 'join', '{"not":"a descriptor"}'], { realmDir: dir3 })
    assert.equal(junk.code, 1)
    assert.equal(junk.error.code, 'EREALM_VERIFY')
  })

  it('a joined realm moves forward only: a higher serial is adopted, an older one is refused', async () => {
    const rev = await fx.ok(['realm', 'revoke', created.realm.id, '--epoch', ...PP])
    const up = await memberOk(['realm', 'join', rev.descriptor])
    assert.equal(up.adopted, true)
    assert.equal(up.realm.serial, 2)
    assert.equal(up.identity.created, false)
    const back = await member(['realm', 'join', created.descriptor])
    assert.equal(back.code, 1)
    assert.match(back.error.message, /stale-serial/)
  })

  it('authority-less realms: create, then join with no passphrase and no credential', async () => {
    const al = await fx.ok(['realm', 'create', 'commons', '--authority-less'])
    const res = await memberOk(['realm', 'join', al.descriptor])
    assert.equal(res.realm.form, 'authorityless')
    assert.equal(res.pinned, 'computed')
    assert.ok(res.identity.podId)
    const bad = await member(['realm', 'join', al.descriptor, '--credential', join(fx.dir, 'mine.cred.json')])
    assert.equal(bad.code, 2)
    const ls = await memberOk(['realm', 'ls'])
    assert.ok(ls.realms.some((r) => r.id === al.realm.id && r.form === 'authorityless'))
  })

  it('ls lists realms with what this machine holds; a reference can be an id prefix or a name', async () => {
    const adminLs = await fx.ok(['realm', 'ls'])
    const row = adminLs.realms.find((r) => r.id === created.realm.id)
    assert.equal(row.name, 'club')
    assert.equal(row.holds.root, true)
    assert.equal(row.holds.issuers, 1)
    assert.equal(row.member, null)
    const mLs = await memberOk(['realm', 'ls'])
    const mrow = mLs.realms.find((r) => r.id === created.realm.id)
    assert.equal(mrow.holds.root, false)
    assert.equal(mrow.holds.issuers, 0)
    assert.ok(mrow.member.podId)
    const byPrefix = await memberOk(['realm', 'inspect', created.realm.id.slice(0, 10)])
    assert.equal(byPrefix.realm.id, created.realm.id)
    const byName = await memberOk(['realm', 'inspect', 'club'])
    assert.equal(byName.realm.id, created.realm.id)
    const none = await member(['realm', 'inspect', 'zzzzzzzzzzzz'])
    assert.equal(none.code, 4)
    assert.equal(none.error.code, 'EREALM_NOT_FOUND')
  })

  it('inspect shows the stored descriptor and the local profile, and says plainly it cannot list live peers', async () => {
    const res = await memberOk(['realm', 'inspect', created.realm.id])
    assert.equal(res.realm.id, created.realm.id)
    assert.equal(res.descriptor.name, 'club')
    assert.equal(res.descriptor.serial, 2)
    assert.equal(res.descriptor.verified, true)
    assert.match(res.note, /cannot list/i)
    assert.match(res.note, /peers/i)
    assert.equal('peers' in res, false)
    assert.equal(res.custody.root, null)
    assert.ok(res.profile.identity.podId)
  })

  it('on the admin machine inspect shows the custody: root and issuer public keys, never a secret', async () => {
    const res = await fx.ok(['realm', 'inspect', created.realm.id])
    assert.equal(res.custody.root.publicKey, created.root.publicKey)
    assert.deepEqual(res.custody.issuers.map((i) => i.publicKey), [created.issuer.publicKey])
    assert.doesNotMatch(JSON.stringify(res), /"ct"|"d":/)
    assert.ok(res.ledger.nextSerial >= 1)
  })
})
