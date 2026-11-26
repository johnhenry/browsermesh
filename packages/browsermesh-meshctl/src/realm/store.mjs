/**
 * realm/store.mjs -- the on-disk realm store: one owner-only directory per realm id.
 *
 *   <realm-dir>/<realm id>/                   0700
 *     descriptor.json       the signed descriptor text, exactly as signed (what `export` returns)
 *     ledger.json           the issuer ledger (the realm package's export); present where keys are held
 *     root.key.json         the sealed ROOT key (keyvault record); present only on the machine that holds it
 *     issuer.key.json       the sealed ISSUER key
 *     issued/<serial>.json  credentials this machine issued (public text; kept so `export` can re-send one)
 *     profile/              the member profile (0700)
 *       identity.json       this machine's independent per-realm identity (a JWK, mode 0600, like meshctl's own)
 *       credentials/<serial>.json  credentials joined with `--credential`
 *
 * Every file is written 0600 through a temporary file and a rename, so a crash leaves the old file or the new one.
 */

import { chmod, mkdir, readFile, readdir, rename, writeFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { RealmCliError, UsageError } from './errors.mjs'

export const DEFAULT_REALM_DIR = join(homedir(), '.config', 'browsermesh', 'realms')

const ID = /^[A-Za-z0-9_-]{43}$/
export const FILES = Object.freeze({
  descriptor: 'descriptor.json',
  ledger: 'ledger.json',
  root: 'root.key.json',
  rootNext: 'root.key.json.next',
  issuer: 'issuer.key.json',
  identity: join('profile', 'identity.json'),
})

export const credentialFile = (serial) => join('profile', 'credentials', `${serial}.json`)
export const issuedFile = (serial) => join('issued', `${serial}.json`)

/** Make `dir` (and its parents) and force it to 0700 regardless of umask. */
async function privateDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
}

export function createStore(root) {
  const realmPath = (id) => join(root, id)
  const file = (id, name) => join(realmPath(id), name)

  async function read(id, name) {
    try {
      return await readFile(file(id, name), 'utf8')
    } catch (err) {
      if (err?.code === 'ENOENT') return null
      throw err
    }
  }

  async function exists(id, name) {
    try {
      await stat(file(id, name))
      return true
    } catch (err) {
      if (err?.code === 'ENOENT') return false
      throw err
    }
  }

  /** Atomic, owner-only write of `text` to `<realm>/<name>`; every directory on the way is 0700. */
  async function write(id, name, text) {
    const target = file(id, name)
    await privateDir(realmPath(id))
    let dir = dirname(target)
    const toFix = []
    while (dir !== realmPath(id) && dir.startsWith(realmPath(id))) {
      toFix.unshift(dir)
      dir = dirname(dir)
    }
    for (const d of toFix) await privateDir(d)
    // Created exclusively (`wx`, so never through a pre-planted file or symlink) with 0600 at creation, then renamed.
    const tmp = `${target}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
    await writeFile(tmp, text, { mode: 0o600, flag: 'wx' })
    await rename(tmp, target)
  }

  async function ids() {
    let names
    try {
      names = await readdir(root)
    } catch (err) {
      if (err?.code === 'ENOENT') return []
      throw err
    }
    const out = []
    for (const n of names.sort()) {
      if (ID.test(n) && (await exists(n, FILES.descriptor))) out.push(n)
    }
    return out
  }

  /**
   * Resolve a reference (full id, an id prefix of 6 or more characters, or a realm name) to one realm id.
   * @param {unknown} ref
   * @returns {Promise<string>}
   */
  async function resolve(ref) {
    if (typeof ref !== 'string' || ref.length === 0) throw new UsageError('a realm (id, id prefix or name) is required')
    const all = await ids()
    if (all.includes(ref)) return ref
    const hits = new Set(ref.length >= 6 ? all.filter((id) => id.startsWith(ref)) : [])
    for (const id of all) {
      try {
        if (JSON.parse(await read(id, FILES.descriptor)).name === ref) hits.add(id)
      } catch { /* a damaged descriptor is reported when it is loaded */ }
    }
    if (hits.size === 0) throw new RealmCliError('EREALM_NOT_FOUND', `no realm '${ref}' in ${root} (try: meshctl realm ls)`)
    if (hits.size > 1) throw new RealmCliError('EREALM_AMBIGUOUS', `'${ref}' matches ${hits.size} realms (${[...hits].join(', ')}); use the full id`)
    return [...hits][0]
  }

  return { root, realmPath, file, read, exists, write, ids, resolve, privateDir, rename: (id, a, b) => rename(file(id, a), file(id, b)) }
}
