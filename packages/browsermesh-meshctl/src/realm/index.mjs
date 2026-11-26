/**
 * realm/index.mjs -- `meshctl realm ...`: the operator and member front end for realms (docs/design/realms.md).
 *
 * meshctl is stateless between invocations except for its local files, so everything here is files in the realm
 * store (`store.mjs`) and signing with keys sealed under a passphrase (`custody.mjs`). No command touches the network.
 * `@johnhenry/browsermesh-realm` is loaded lazily (`load.mjs`); `realm invite` and a bad subcommand are answered
 * without it.
 *
 * Admin half = LOCAL KEY CUSTODY and OFFLINE SIGNING; it grants nothing on anyone else's host. The member half stores
 * a verified descriptor, an independent per-realm identity, and credentials.
 *
 * ONE ledger per realm is shared by the root and the issuer key this machine holds, so credential serials never
 * collide (`descriptor.revoked` is a flat list of serials with no issuer).
 */

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { UsageError, RealmCliError, building, verifyError } from './errors.mjs'
import { loadRealmPackage } from './load.mjs'
import { join } from 'node:path'
import { createStore, DEFAULT_REALM_DIR, FILES, credentialFile, issuedFile } from './store.mjs'
import { readPassphrase, generateKey, sealKey, sealedHeader, unsealKey } from './custody.mjs'
import { loadOrCreateIdentity } from '../identity.mjs'

export const REALM_COMMANDS = ['create', 'issue', 'revoke', 'rotate', 'ledger', 'join', 'ls', 'inspect', 'export', 'invite']

const DAY = 86400
const DEFAULT_ISSUER_TTL = 365 * DAY
const INSPECT_NOTE = 'meshctl keeps no session between invocations, so it cannot list live peers: this shows the stored descriptor and the local profile only.'
const NOT_IMPLEMENTED = 'realm invite is not implemented in v1: there is no keyless credential, so no tickets or admitters. '
  + 'Issue a key-bound credential instead: meshctl realm issue <realm> --role <role> --key <public key> '
  + '(the member runs meshctl realm join first to get its per-realm public key).'

const DEFAULT_ROLES = { guest: ['protocol:mcp:open'], member: ['protocol:mcp:open', 'mcp:tool:call'] }

const nowSeconds = () => Math.floor(Date.now() / 1000)

// ---- small parsers ------------------------------------------------------------------------------------------------

/** `7d`, `24h`, `30m`, `90s` or bare seconds, as whole seconds. */
function parseDuration(value, flag) {
  const m = typeof value === 'string' ? /^(\d+)([smhd]?)$/.exec(value) : null
  if (!m) throw new UsageError(`${flag} must be a duration like 7d, 24h, 30m or 90s`)
  const n = Number(m[1]) * { '': 1, s: 1, m: 60, h: 3600, d: DAY }[m[2]]
  if (!Number.isSafeInteger(n) || n < 1) throw new UsageError(`${flag} must be a positive duration`)
  return n
}

function stringFlag(flags, name) {
  const v = flags[name]
  if (v === undefined) return undefined
  if (typeof v !== 'string' || v.length === 0) throw new UsageError(`--${name} needs a value`)
  return v
}

async function readFileOrEnoent(path, what) {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') throw new RealmCliError('ENOENT', `${what} '${path}' does not exist`)
    throw err
  }
}

/** A JSON value given inline (`{...}`) or as a file path. */
async function jsonOrFile(value, flag) {
  if (typeof value !== 'string' || value.length === 0) throw new UsageError(`${flag} needs inline JSON or a file path`)
  const text = /^\s*[{[]/.test(value) ? value : await readFileOrEnoent(value, `${flag} file`)
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new UsageError(`${flag} is not valid JSON: ${err.message}`)
  }
}

/** Descriptor and credential texts are byte-exact; an editor's one trailing newline is not part of them. */
const stripNewline = (s) => s.replace(/\r?\n$/, '')

const positiveInt = (v, what) => {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN
  if (!Number.isSafeInteger(n) || n < 1) throw new UsageError(`${what} must be a positive integer`)
  return n
}

// ---- loading a realm ----------------------------------------------------------------------------------------------

/**
 * Load and verify a stored realm. The descriptor is checked end to end against its own id (signature and chain), with
 * staleness (`validUntil`) reported rather than refused, so an operator can still re-sign a stale realm.
 */
async function loadRealm(ctx, ref) {
  const { store, pkg } = ctx
  const id = await store.resolve(ref)
  const text = await store.read(id, FILES.descriptor)
  let form = 'signed'
  try {
    if (JSON.parse(text)?.form === 'authorityless') form = 'authorityless'
  } catch { /* the verifier reports it */ }
  const verdict = form === 'authorityless'
    ? await pkg.verifyAuthorityless(text, { pinnedId: id })
    : await pkg.verifyDescriptor(text, { pinnedId: id, now: 0 })
  if (!verdict.ok) throw new RealmCliError('EREALM_CORRUPT', `the stored descriptor for ${id} does not verify: ${verdict.reason}`)
  const descriptor = verdict.descriptor
  const stale = form === 'signed' && pkg.isStale(descriptor, ctx.now())
  return { id, form, text, descriptor, stale }
}

function summary(r) {
  const d = r.descriptor
  return r.form === 'authorityless'
    ? { id: d.id, name: d.name, mode: 'open', form: 'authorityless' }
    : { id: d.id, name: d.name, mode: d.mode, form: 'signed', serial: d.serial, epoch: d.epoch, ttl: d.ttl }
}

function requireAuthority(r, what) {
  if (r.form === 'authorityless') throw new UsageError(`${what}: an authority-less realm has no root and no issuers, so there is nothing to ${what}`)
}

/** The descriptor's own fields, to re-sign with a change. */
function fieldsOf(d) {
  const { v, id, sig, ...rest } = d
  return rest
}

/**
 * Find the sealed key file for `role` whose public key is the one the descriptor names. For the root this looks at
 * `root.key.json.next` too, so a `rotate` that crashed between writing the descriptor and renaming the key recovers.
 */
async function findKey(ctx, realm, role) {
  const wanted = role === 'root' ? [realm.descriptor.root.key] : realm.descriptor.issuers.map((i) => i.key)
  const names = role === 'root' ? [FILES.root, FILES.rootNext] : [FILES.issuer]
  for (const name of names) {
    const text = await ctx.store.read(realm.id, name)
    if (text === null) continue
    const header = sealedHeader(text)
    if (header && header.realm === realm.id && header.role === role && wanted.includes(header.publicKey)) {
      return { name, text, publicKey: header.publicKey }
    }
  }
  return null
}

async function readLedger(ctx, id) {
  const text = await ctx.store.read(id, FILES.ledger)
  return text === null ? null : ctx.pkg.importLedger(text)
}

async function verifySigned(ctx, realm, text, what) {
  const v = await ctx.pkg.verifyDescriptor(text, { pinnedId: realm.id, now: 0, heldChain: realm.descriptor.root.chain })
  if (!v.ok) throw verifyError(what, v)
  return v
}

// ---- create -------------------------------------------------------------------------------------------------------

async function cmdCreate(ctx) {
  const { pkg, store, flags, positionals } = ctx
  const name = positionals[0]
  if (!name) throw new UsageError('realm create <name> [--mode open|invite] [--authority-less] [--ttl 7d] [--rendezvous <json|file>] [--roles <json|file>]')
  const authorityless = flags['authority-less'] === true
  const mode = stringFlag(flags, 'mode') ?? (authorityless ? 'open' : 'invite')
  if (mode !== 'open' && mode !== 'invite') throw new UsageError("--mode must be 'open' or 'invite'")
  if (authorityless && mode !== 'open') throw new UsageError('an authority-less realm is open: it cannot be --mode invite')
  if (flags.admitter !== undefined) throw new RealmCliError('EREALM_NOT_IMPLEMENTED', 'admitters are not implemented in v1 (no tickets); see meshctl realm issue')
  const ttl = flags.ttl === undefined ? undefined : parseDuration(flags.ttl, '--ttl')
  const rendezvous = flags.rendezvous === undefined ? undefined : await jsonOrFile(flags.rendezvous, '--rendezvous')
  const roles = flags.roles === undefined
    ? (authorityless ? { guest: DEFAULT_ROLES.guest } : DEFAULT_ROLES)
    : await jsonOrFile(flags.roles, '--roles')

  if (authorityless) {
    if (ttl !== undefined) throw new UsageError('--ttl does not apply to an authority-less realm (it has no credentials)')
    const made = await building(() => pkg.createAuthorityless({ name, roles, hints: rendezvous, salt: stringFlag(flags, 'salt') }))
    const id = made.descriptor.id
    if (await store.exists(id, FILES.descriptor)) throw new RealmCliError('EREALM_EXISTS', `realm ${id} is already in ${store.root}`)
    await store.write(id, FILES.descriptor, made.text)
    return {
      realm: { id, name, mode: 'open', form: 'authorityless' },
      realmDir: store.realmPath(id),
      descriptor: made.text,
      root: null,
      issuer: null,
    }
  }

  const issuerTtl = flags['issuer-ttl'] === undefined ? DEFAULT_ISSUER_TTL : parseDuration(flags['issuer-ttl'], '--issuer-ttl')
  const passphrase = await readPassphrase(flags, ctx.env)

  const root = await generateKey()
  const issuer = await generateKey()
  const id = await pkg.keyId(root.publicKey)
  const issuerNotAfter = ctx.now() + issuerTtl
  const unsigned = await building(() => pkg.createDescriptor({
    name, mode, root: { key: root.publicKey }, issuers: [{ key: issuer.publicKey, notAfter: issuerNotAfter }], roles, rendezvous, ttl,
  }))
  const signed = await building(() => pkg.signDescriptor(unsigned, root.identity))
  const verdict = await pkg.verifyDescriptor(signed.text, { pinnedId: id })
  if (!verdict.ok) throw verifyError('the descriptor just created', verdict)
  if (await store.exists(id, FILES.descriptor)) throw new RealmCliError('EREALM_EXISTS', `realm ${id} is already in ${store.root}`)

  await store.write(id, FILES.root, await sealKey(root, { realm: id, role: 'root' }, passphrase))
  await store.write(id, FILES.issuer, await sealKey(issuer, { realm: id, role: 'issuer' }, passphrase))
  await store.write(id, FILES.ledger, pkg.createLedger().export())
  await store.write(id, FILES.descriptor, signed.text) // last: a realm exists once its descriptor does

  const d = verdict.descriptor
  return {
    realm: { id, name, mode, form: 'signed', serial: d.serial, epoch: d.epoch, ttl: d.ttl },
    realmDir: store.realmPath(id),
    descriptor: signed.text,
    root: { publicKey: root.publicKey, file: FILES.root },
    issuer: { publicKey: issuer.publicKey, notAfter: issuerNotAfter, file: FILES.issuer },
  }
}

// ---- issue --------------------------------------------------------------------------------------------------------

async function cmdIssue(ctx) {
  const { pkg, store, flags, positionals } = ctx
  const realm = await loadRealm(ctx, positionals[0])
  requireAuthority(realm, 'issue')
  const role = stringFlag(flags, 'role')
  const subject = stringFlag(flags, 'key')
  if (!role || !subject) throw new UsageError('realm issue <realm> --role <role> --key <public key> [--ttl 7d] [--out <file>]')
  const d = realm.descriptor
  if (!Object.hasOwn(d.roles, role)) throw new UsageError(`the realm does not define role '${role}' (it defines: ${Object.keys(d.roles).join(', ')})`)
  const ttl = flags.ttl === undefined ? d.ttl : parseDuration(flags.ttl, '--ttl')
  if (ttl > d.ttl) throw new UsageError(`--ttl is longer than the realm's ttl (${d.ttl}s): a verifier would clamp it`)
  const out = stringFlag(flags, 'out')

  const now = ctx.now()
  const issuerKey = await findKey(ctx, realm, 'issuer')
  if (!issuerKey) throw new RealmCliError('EREALM_NO_KEY', 'this machine holds no issuer key for the realm (credentials are signed by an issuer key only, never by the root)')
  const issuerEntry = d.issuers.find((i) => i.key === issuerKey.publicKey)
  if (issuerEntry.notAfter <= now) throw new RealmCliError('EREALM_NO_KEY', 'the issuer key has expired')
  const passphrase = await readPassphrase(flags, ctx.env)

  const ledger = await readLedger(ctx, realm.id) ?? pkg.createLedger()
  const identity = await unsealKey(issuerKey.text, passphrase, { realm: realm.id, role: 'issuer', publicKey: issuerKey.publicKey })
  const notAfter = now + ttl
  const entry = await building(async () => ledger.allocate({ subject, role, notAfter }))
  const issued = await building(() => pkg.issueCredential(
    { realm: realm.id, subject, role, serial: entry.serial, notBefore: now, notAfter, epoch: d.epoch }, identity,
  ))
  const check = await pkg.verifyCredential(issued.text, d, { now })
  if (!check.ok) throw verifyError('the credential just issued', check)

  await store.write(realm.id, FILES.ledger, ledger.export())
  await store.write(realm.id, issuedFile(entry.serial), issued.text)
  if (out) await writeFile(out, issued.text)
  return {
    realm: realm.id,
    credential: issued.text,
    serial: entry.serial,
    subject,
    role,
    notBefore: now,
    notAfter,
    epoch: d.epoch,
    issuer: issuerKey.publicKey,
    verified: true,
    ...(out ? { out } : {}),
  }
}

// ---- revoke -------------------------------------------------------------------------------------------------------

async function cmdRevoke(ctx) {
  const { pkg, store, flags, positionals } = ctx
  const realm = await loadRealm(ctx, positionals[0])
  requireAuthority(realm, 'revoke')
  const byEpoch = flags.epoch === true
  if (flags.epoch !== undefined && !byEpoch) throw new UsageError('--epoch takes no value')
  if (byEpoch === (flags.serial !== undefined)) throw new UsageError('realm revoke <realm> needs exactly one of --serial <n> or --epoch')
  const serial = byEpoch ? undefined : positiveInt(flags.serial, '--serial')
  const d = realm.descriptor
  const now = ctx.now()

  const ledger = await readLedger(ctx, realm.id)
  if (!ledger && !byEpoch) throw new RealmCliError('ENOENT', 'this machine holds no ledger for the realm')
  const live = ledger ?? pkg.createLedger()
  if (!byEpoch) {
    if (live.get(serial) === null) throw new RealmCliError('ENOENT', `no credential with serial ${serial} in this realm's ledger`)
    if (d.revoked.includes(serial)) {
      return { realm: realm.id, action: 'serial', serial, changed: false, descriptorSerial: d.serial, epoch: d.epoch, revoked: d.revoked, descriptor: realm.text }
    }
  }
  const rootKey = await findKey(ctx, realm, 'root')
  if (!rootKey) throw new RealmCliError('EREALM_NO_KEY', 'this machine does not hold the realm root key, and only the root signs descriptors (a serial revocation is a new descriptor)')
  const passphrase = await readPassphrase(flags, ctx.env)
  const identity = await unsealKey(rootKey.text, passphrase, { realm: realm.id, role: 'root', publicKey: rootKey.publicKey })

  if (!byEpoch) live.markRevoked(serial)
  const revoked = await building(async () => live.revokedSerials({ now }))
  const next = await building(() => pkg.createDescriptor({
    ...fieldsOf(d), serial: d.serial + 1, epoch: byEpoch ? d.epoch + 1 : d.epoch, revoked,
  }))
  const signed = await building(() => pkg.signDescriptor(next, identity))
  await verifySigned(ctx, realm, signed.text, 'the re-signed descriptor')

  if (ledger) await store.write(realm.id, FILES.ledger, live.export()) // ledger first: see the note in the README
  await store.write(realm.id, FILES.descriptor, signed.text)
  const nd = JSON.parse(signed.text)
  return {
    realm: realm.id,
    action: byEpoch ? 'epoch' : 'serial',
    ...(byEpoch ? {} : { serial }),
    changed: true,
    descriptorSerial: nd.serial,
    epoch: nd.epoch,
    revoked: nd.revoked,
    descriptor: signed.text,
  }
}

// ---- rotate -------------------------------------------------------------------------------------------------------

async function cmdRotate(ctx) {
  const { pkg, store, flags, positionals } = ctx
  const realm = await loadRealm(ctx, positionals[0])
  requireAuthority(realm, 'rotate')
  const d = realm.descriptor
  const rootKey = await findKey(ctx, realm, 'root')
  if (!rootKey) throw new RealmCliError('EREALM_NO_KEY', 'this machine does not hold the realm root key')
  const passphrase = await readPassphrase(flags, ctx.env)
  const outgoing = await unsealKey(rootKey.text, passphrase, { realm: realm.id, role: 'root', publicKey: rootKey.publicKey })

  const successor = await generateKey()
  const statement = await building(() => pkg.createRotation(
    { realm: realm.id, pos: d.root.chain.length + 1, from: rootKey.publicKey, to: successor.publicKey, effective: ctx.now() },
    outgoing, successor.identity,
  ))
  const next = await building(() => pkg.createDescriptor({
    ...fieldsOf(d), serial: d.serial + 1, root: { key: successor.publicKey, chain: [...d.root.chain, statement] },
  }))
  const signed = await building(() => pkg.signDescriptor(next, successor.identity))
  const verdict = await verifySigned(ctx, realm, signed.text, 'the rotated descriptor')

  // The sealed successor first, then the descriptor, then the rename that retires the old key: whichever step a crash
  // stops at, `findKey` still finds the key the descriptor on disk names.
  await store.write(realm.id, FILES.rootNext, await sealKey(successor, { realm: realm.id, role: 'root' }, passphrase))
  await store.write(realm.id, FILES.descriptor, signed.text)
  await store.rename(realm.id, FILES.rootNext, FILES.root)
  return {
    realm: realm.id,
    descriptorSerial: verdict.descriptor.serial,
    chainLength: verdict.chainLength,
    root: { publicKey: successor.publicKey, previous: rootKey.publicKey, file: FILES.root },
    descriptor: signed.text,
  }
}

// ---- ledger -------------------------------------------------------------------------------------------------------

async function cmdLedger(ctx) {
  const realm = await loadRealm(ctx, ctx.positionals[0])
  if (realm.form === 'authorityless') throw new UsageError('an authority-less realm has no issuer, so it has no ledger')
  const ledger = await readLedger(ctx, realm.id)
  if (!ledger) throw new RealmCliError('ENOENT', 'this machine holds no ledger for the realm (only the machine that issues keeps one)')
  return { realm: realm.id, nextSerial: ledger.nextSerial, entries: ledger.list(), revoked: realm.descriptor.revoked }
}

// ---- join ---------------------------------------------------------------------------------------------------------

async function readIdentitySummary(ctx, id) {
  const text = await ctx.store.read(id, FILES.identity)
  if (text === null) return null
  const rec = JSON.parse(text)
  return { podId: rec.podId, publicKey: rec.privateKeyJwk.x, file: FILES.identity }
}

async function cmdJoin(ctx) {
  const { pkg, store, flags, positionals } = ctx
  const arg = positionals[0]
  if (!arg) throw new UsageError('realm join <descriptor-file|text> [--id <realm id>] [--credential <file>]')
  const text = stripNewline(/^\s*\{/.test(arg) ? arg : await readFileOrEnoent(arg, 'descriptor file'))
  let doc
  try {
    doc = JSON.parse(text)
  } catch {
    throw new RealmCliError('EREALM_VERIFY', 'the descriptor is not JSON')
  }
  const given = stringFlag(flags, 'id')
  const pinnedId = given ?? doc?.id
  if (typeof pinnedId !== 'string') throw new RealmCliError('EREALM_VERIFY', 'the descriptor has no id')
  const authorityless = doc?.form === 'authorityless'
  const credentialPath = stringFlag(flags, 'credential')
  if (authorityless && credentialPath) throw new UsageError('an authority-less realm has no credentials: it admits guests only')

  const now = ctx.now()
  const verdict = authorityless
    ? await pkg.verifyAuthorityless(text, { pinnedId })
    : await pkg.verifyDescriptor(text, { pinnedId, now })
  if (!verdict.ok) throw verifyError('the descriptor', verdict)
  const id = verdict.descriptor.id

  const heldText = await store.read(id, FILES.descriptor)
  let adopted = heldText !== text
  if (heldText !== null && adopted && !authorityless) {
    const held = await pkg.verifyDescriptor(heldText, { pinnedId: id, now: 0 })
    if (!held.ok) throw new RealmCliError('EREALM_CORRUPT', `the stored descriptor for ${id} does not verify: ${held.reason}`)
    const verdict2 = await pkg.adoptDescriptor(held.descriptor, text, { pinnedId: id, now })
    if (!verdict2.ok) throw verifyError('the descriptor (against the one held)', verdict2)
  }
  const effective = verdict.descriptor // identical to the held one when `adopted` is false

  // Everything that can refuse is checked before anything is written.
  let credential = null
  if (credentialPath) {
    const credText = stripNewline(await readFileOrEnoent(credentialPath, 'credential file'))
    const checked = await pkg.verifyCredential(credText, effective, { now })
    if (!checked.ok) throw verifyError('the credential', checked)
    const mine = await readIdentitySummary(ctx, id)
    if (!mine) throw new RealmCliError('EREALM_VERIFY', 'this machine has no identity for the realm yet: run realm join without --credential, give the printed public key to the issuer, then join again with the credential')
    if (pkg.checkSubject(checked, mine.publicKey).ok !== true) {
      throw new RealmCliError('EREALM_VERIFY', "the credential's subject is not this realm identity's public key (it was issued to another key)")
    }
    credential = { text: credText, checked }
  }

  if (adopted) await store.write(id, FILES.descriptor, text)
  else await store.privateDir(store.realmPath(id))
  await store.privateDir(store.file(id, 'profile'))
  const made = await loadOrCreateIdentity({ identityPath: store.file(id, FILES.identity), label: `realm:${effective.name}` })
  const identity = { ...(await readIdentitySummary(ctx, id)), created: made.created }

  let stored = null
  if (credential) {
    const file = credentialFile(credential.checked.credential.serial)
    await store.write(id, file, credential.text)
    stored = {
      serial: credential.checked.credential.serial, role: credential.checked.credential.role,
      notAfter: credential.checked.effective.notAfter, verified: true, file,
    }
  }
  return {
    realm: summary({ form: authorityless ? 'authorityless' : 'signed', descriptor: effective }),
    adopted,
    pinned: given ? 'given' : 'computed',
    identity,
    credential: stored,
  }
}

// ---- ls / inspect -------------------------------------------------------------------------------------------------

async function memberSummary(ctx, id) {
  const identity = await readIdentitySummary(ctx, id)
  if (!identity) return null
  return { podId: identity.podId, publicKey: identity.publicKey, credentials: (await credentialFiles(ctx, id)).length }
}

async function credentialFiles(ctx, id) {
  try {
    return (await readdir(ctx.store.file(id, join('profile', 'credentials')))).filter((f) => /^\d+\.json$/.test(f)).map((f) => Number.parseInt(f, 10)).sort((a, b) => a - b)
  } catch (err) {
    if (err?.code === 'ENOENT') return []
    throw err
  }
}

async function holdings(ctx, realm) {
  if (realm.form === 'authorityless') return { root: false, issuers: 0 }
  return {
    root: (await findKey(ctx, realm, 'root')) !== null,
    issuers: (await findKey(ctx, realm, 'issuer')) !== null ? 1 : 0,
  }
}

async function cmdLs(ctx) {
  const realms = []
  for (const id of await ctx.store.ids()) {
    const r = await loadRealm(ctx, id)
    realms.push({ ...summary(r), serial: r.descriptor.serial ?? null, epoch: r.descriptor.epoch ?? null, holds: await holdings(ctx, r), member: await memberSummary(ctx, id) })
  }
  realms.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  return { realmDir: ctx.store.root, realms }
}

async function cmdInspect(ctx) {
  const { pkg } = ctx
  const realm = await loadRealm(ctx, ctx.positionals[0])
  const now = ctx.now()
  const custody = { root: null, issuers: [] }
  let ledger = null
  if (realm.form === 'signed') {
    const root = await findKey(ctx, realm, 'root')
    if (root) custody.root = { publicKey: root.publicKey, file: root.name === FILES.rootNext ? FILES.root : root.name }
    const issuer = await findKey(ctx, realm, 'issuer')
    if (issuer) {
      custody.issuers.push({ publicKey: issuer.publicKey, notAfter: realm.descriptor.issuers.find((i) => i.key === issuer.publicKey).notAfter, file: issuer.name })
    }
    const l = await readLedger(ctx, realm.id)
    if (l) {
      const entries = l.list()
      ledger = { nextSerial: l.nextSerial, issued: entries.filter((e) => e.state === 'issued').length, revoked: entries.filter((e) => e.state === 'revoked').length }
    }
  }
  const credentials = []
  for (const serial of await credentialFiles(ctx, realm.id)) {
    const file = credentialFile(serial)
    const text = await ctx.store.read(realm.id, file)
    const c = realm.form === 'signed' ? await pkg.verifyCredential(text, realm.descriptor, { now }) : { ok: false, reason: 'no-credentials' }
    const doc = JSON.parse(text)
    credentials.push({ serial, role: doc.role, notAfter: c.ok ? c.effective.notAfter : doc.notAfter, valid: c.ok, ...(c.ok ? {} : { reason: c.reason }), file })
  }
  return {
    realm: summary(realm),
    descriptor: { ...realm.descriptor, verified: true, stale: realm.stale },
    custody,
    ledger,
    profile: { identity: await readIdentitySummary(ctx, realm.id), credentials },
    note: INSPECT_NOTE,
  }
}

// ---- export -------------------------------------------------------------------------------------------------------

async function cmdExport(ctx) {
  const { flags, store } = ctx
  const realm = await loadRealm(ctx, ctx.positionals[0])
  const wantsCredential = flags.credential !== undefined
  if (wantsCredential && flags.descriptor !== undefined) throw new UsageError('give --descriptor or --credential <serial>, not both')
  const out = stringFlag(flags, 'out')
  let result
  if (wantsCredential) {
    const serial = positiveInt(flags.credential, '--credential')
    const text = (await store.read(realm.id, credentialFile(serial))) ?? (await store.read(realm.id, issuedFile(serial)))
    if (text === null) throw new RealmCliError('ENOENT', `no credential with serial ${serial} is stored for this realm on this machine`)
    result = { realm: realm.id, serial, credential: text }
    if (out) await writeFile(out, text)
  } else {
    result = { realm: realm.id, descriptor: realm.text }
    if (out) await writeFile(out, realm.text)
  }
  return out ? { ...result, out } : result
}

// ---- dispatch -----------------------------------------------------------------------------------------------------

const HANDLERS = {
  create: cmdCreate, issue: cmdIssue, revoke: cmdRevoke, rotate: cmdRotate, ledger: cmdLedger,
  join: cmdJoin, ls: cmdLs, inspect: cmdInspect, export: cmdExport,
}

/**
 * @param {{ cmd: string, positionals: string[], flags: Record<string, *>, env?: Record<string, string | undefined> }} parsed
 */
export async function runRealmCommand({ cmd, positionals, flags, env = process.env }) {
  if (cmd === 'invite') throw new RealmCliError('EREALM_NOT_IMPLEMENTED', NOT_IMPLEMENTED)
  const handler = HANDLERS[cmd]
  if (!handler) throw new UsageError(`realm: unknown subcommand '${cmd}' (expected one of ${REALM_COMMANDS.join('|')})`)
  const pkg = await loadRealmPackage()
  const dir = flags['realm-dir']
  if (dir !== undefined && (typeof dir !== 'string' || dir.length === 0)) throw new UsageError('--realm-dir needs a directory')
  const store = createStore(dir ?? DEFAULT_REALM_DIR)
  return handler({ pkg, store, flags, positionals, env, now: nowSeconds })
}
