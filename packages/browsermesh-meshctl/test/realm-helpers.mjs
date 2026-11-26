/**
 * realm-helpers.mjs -- a throwaway realm store, a passphrase in a fake environment, and the CLI wrapped to parse its
 * JSON. The passphrase lives only in the `env` object handed to `runCli`, never in argv.
 */

import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from './helpers.mjs'

export const PASSPHRASE = 'correct horse battery staple 7f3a'
export const PP = ['--passphrase-env', 'MESHCTL_TEST_PP']

export async function realmFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'meshctl-realm-'))
  const realmDir = join(dir, 'realms')
  const env = { MESHCTL_TEST_PP: PASSPHRASE }
  const seen = []

  /** Run a command; `extraEnv` overrides the fake environment. Returns { code, result, error, stdout, stderr }. */
  async function run(argv, { env: extraEnv, realmDir: dirOverride } = {}) {
    const args = [...argv, '--realm-dir', dirOverride ?? realmDir]
    const r = await runCli(args, { env: { ...env, ...extraEnv } })
    seen.push(r.stdout, r.stderr)
    const line = r.stderr.split('\n').find((l) => l.startsWith('{'))
    return {
      ...r,
      error: line ? JSON.parse(line).error : null,
      result: r.stdout ? JSON.parse(r.stdout).result : null,
    }
  }

  /** Run and require success; returns the result document. */
  async function ok(argv, opts) {
    const r = await run(argv, opts)
    if (r.code !== 0) throw new Error(`meshctl ${argv.join(' ')} exited ${r.code}: ${r.stderr}`)
    return r.result
  }

  async function passphraseFile(mode = 0o600, text = `${PASSPHRASE}\n`) {
    const path = join(dir, `pp-${mode.toString(8)}-${seen.length}.txt`)
    await writeFile(path, text, { mode })
    await chmod(path, mode)
    return path
  }

  return {
    dir, realmDir, env, run, ok, passphraseFile, seen,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

/** A fresh public key (base64url, 32 raw bytes) to issue to. */
export async function freshKey() {
  const { PodIdentity, encodeBase64url } = await import('@johnhenry/browsermesh-primitives')
  const id = await PodIdentity.generate()
  return encodeBase64url(await id.rawPublicKey())
}
