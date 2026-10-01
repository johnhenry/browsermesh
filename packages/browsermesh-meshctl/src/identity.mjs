/**
 * identity.mjs — `meshctl`'s own mesh identity, persisted to disk.
 *
 * `meshctl` IS a pod (issue #185 item 5's design): it boots its own mesh
 * identity and joins the mesh like any other peer, rather than exposing a
 * separate admin API. That identity has to survive between invocations --
 * a CLI that minted a fresh Ed25519 keypair on every run would be a
 * different, untrusted peer every time, unable to hold onto grants a host
 * had given it.
 *
 * This reuses `@johnhenry/browsermesh-core`'s `MeshIdentityManager` rather
 * than hand-rolling JWK (de)serialization: `identityManager.export(podId)`
 * already returns the private key as a plain JWK, and
 * `identityManager.import(jwk, label)` already rebuilds the exact same
 * `PodIdentity` (same `derivePodId()` call `spikes/isolate-pod-host/src/
 * identity-jwk.mjs` uses) from one. That spike file's `exportIdentityToJwk`/
 * `importIdentityFromJwk` do the same thing by hand, for a Durable Object's
 * `ctx.storage` -- duplicating that here instead of using the identity
 * manager that already ships in `browsermesh-core` would be exactly the
 * kind of divergence the issue asks CS5 to avoid. `MeshIdentityManager`
 * also gets `meshctl` an `IdentityWallet` (what `PeerNode` requires) for
 * free, and an encrypted-export path (`identityManager.export(podId,
 * passphrase)`) if a future `meshctl identity export --passphrase` wants
 * one, with no extra code here.
 *
 * One identity per file: `meshctl` has no multi-identity UX today, so only
 * the first (and only) identity the manager holds is ever read back.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { IdentityWallet, MeshIdentityManager } from '@johnhenry/browsermesh-core'

/** Default `--identity` path: `~/.config/browsermesh/meshctl-identity.json`. */
export const DEFAULT_IDENTITY_PATH = join(homedir(), '.config', 'browsermesh', 'meshctl-identity.json')

/** Label every `meshctl`-created identity carries, absent `--label`. */
export const DEFAULT_IDENTITY_LABEL = 'meshctl'

/**
 * @typedef {object} MeshctlIdentity
 * @property {string} podId
 * @property {string} label
 * @property {import('@johnhenry/browsermesh-core').IdentityWallet} wallet
 * @property {import('@johnhenry/browsermesh-core').MeshIdentityManager} identityManager
 * @property {boolean} created - `true` when this call generated a fresh identity.
 * @property {string} identityPath
 */

/**
 * Load `identityPath`'s identity, or create and persist a fresh one on
 * first run.
 *
 * @param {object} [opts]
 * @param {string} [opts.identityPath=DEFAULT_IDENTITY_PATH]
 * @param {string} [opts.label=DEFAULT_IDENTITY_LABEL] - Used only when creating.
 * @returns {Promise<MeshctlIdentity>}
 */
export async function loadOrCreateIdentity({
  identityPath = DEFAULT_IDENTITY_PATH,
  label = DEFAULT_IDENTITY_LABEL,
} = {}) {
  const identityManager = new MeshIdentityManager({})
  let podId
  let resolvedLabel = label
  let created = false

  const stored = await readStoredIdentity(identityPath)
  if (stored) {
    resolvedLabel = stored.label || label
    const summary = await identityManager.import(stored.privateKeyJwk, resolvedLabel)
    podId = summary.podId
  } else {
    const summary = await identityManager.create(label)
    podId = summary.podId
    resolvedLabel = label
    created = true
    await persistIdentity(identityPath, {
      podId,
      label,
      privateKeyJwk: await identityManager.export(podId),
    })
  }

  const wallet = new IdentityWallet({ identityManager })
  return { podId, label: resolvedLabel, wallet, identityManager, created, identityPath }
}

/**
 * @param {string} identityPath
 * @returns {Promise<{podId: string, label: string, privateKeyJwk: object}|null>}
 */
async function readStoredIdentity(identityPath) {
  let raw
  try {
    raw = await readFile(identityPath, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return null
    throw err
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`identity file '${identityPath}' is not valid JSON: ${err.message}`)
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.privateKeyJwk) {
    throw new Error(`identity file '${identityPath}' is missing 'privateKeyJwk'`)
  }
  return parsed
}

/**
 * @param {string} identityPath
 * @param {{podId: string, label: string, privateKeyJwk: object}} record
 * @returns {Promise<void>}
 */
async function persistIdentity(identityPath, record) {
  await mkdir(dirname(identityPath), { recursive: true, mode: 0o700 })
  await writeFile(identityPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
}
