/**
 * test/helpers.mjs — `runCli()`: invoke `meshctl`'s `main()` in-process,
 * capturing stdout/stderr/exit code, exactly as the design doc asks for
 * ("a `runCli(argv, {stdin?, env?})` helper that invokes the CLI's
 * main() in-process capturing stdout/stderr/exit code").
 *
 * Also exports small fixtures every test file in this directory reuses:
 * a temp identity file per test, and a loopback session builder with the
 * `grant`/`attach` test-only knobs `loopback.mjs` added specifically for
 * exercising `EACCES`/`ETIMEDOUT` without a real unresponsive host.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../src/cli.mjs'
import { loadOrCreateIdentity } from '../src/identity.mjs'
import { createLoopbackSession } from '../src/loopback.mjs'

/**
 * @returns {{write: (chunk: string) => void, chunks: string[], text: () => string, isTTY: boolean}}
 */
function makeSink({ isTTY = false } = {}) {
  const chunks = []
  return { write: (chunk) => { chunks.push(String(chunk)) }, chunks, text: () => chunks.join(''), isTTY }
}

/**
 * Invoke `meshctl`'s `main()` in-process.
 *
 * @param {string[]} argv
 * @param {object} [opts]
 * @param {import('../src/connect.mjs').MeshctlSession} [opts.session] - Reuse
 *   an already-connected session (see `cli.mjs`'s `dispatch()` doc comment
 *   on why `--loopback` needs this for multi-command test flows).
 * @param {AbortSignal} [opts.signal]
 * @param {Function} [opts.WebSocketCtor]
 * @param {boolean} [opts.isTTY] - Simulate stdout being/not being a TTY.
 * @returns {Promise<{code: number, stdout: string, stderr: string, stdoutLines: string[]}>}
 */
export async function runCli(argv, { session, signal, WebSocketCtor, isTTY = false } = {}) {
  const stdout = makeSink({ isTTY })
  const stderr = makeSink({ isTTY })
  const code = await main(argv, { stdout, stderr, session, signal, WebSocketCtor })
  return {
    code,
    stdout: stdout.text(),
    stderr: stderr.text(),
    stdoutLines: stdout.chunks,
  }
}

/**
 * A temp directory + identity file this test file owns, with a loader and
 * a cleanup callback.
 *
 * @param {string} prefix
 * @returns {Promise<{dir: string, identityPath: string, cleanup: () => Promise<void>}>}
 */
export async function withTempIdentityDir(prefix = 'meshctl-test-') {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  return {
    dir,
    identityPath: join(dir, 'identity.json'),
    async cleanup() {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/**
 * Build a `meshctl` identity in a fresh temp dir.
 * @param {object} [opts]
 * @returns {Promise<{cliIdentity: object, cleanup: () => Promise<void>, identityPath: string}>}
 */
export async function buildTestIdentity(opts = {}) {
  const { identityPath, cleanup } = await withTempIdentityDir()
  const cliIdentity = await loadOrCreateIdentity({ identityPath, ...opts })
  return { cliIdentity, cleanup, identityPath }
}

/**
 * A loopback session with the standard two demo hosts (isolate + node),
 * plus the identity+dir fixture backing it, so tests get one `cleanup()`
 * that tears down everything.
 *
 * @param {object} [opts]
 * @param {{label: string, lane: string, grant?: boolean, attach?: boolean}[]} [opts.hosts]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{session: object, cliIdentity: object, cleanup: () => Promise<void>}>}
 */
export async function buildLoopbackFixture({ hosts, timeoutMs } = {}) {
  const { cliIdentity, cleanup: cleanupIdentity } = await buildTestIdentity()
  const session = await createLoopbackSession({ cliIdentity, hosts, timeoutMs })
  return {
    session,
    cliIdentity,
    async cleanup() {
      await session.close()
      await cleanupIdentity()
    },
  }
}
