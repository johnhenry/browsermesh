/**
 * serve.mjs -- start the self-hosted isolate pod host (`workerd serve
 * workerd.config.capnp`) on an address you choose, and refuse to start when
 * that address is not loopback and no `CONTROL_TOKEN` is set: the control
 * routes spawn, message and drain pods.
 *
 *   node src/serve.mjs                          # 127.0.0.1:8080, no token needed
 *   CONTROL_TOKEN=... node src/serve.mjs --address 0.0.0.0:8080
 *
 * `buildServeCommand()` is the testable half; running the file spawns
 * `workerd` (which must be on PATH). Not exercised against a real workerd by
 * this spike's tests.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { controlAuthProblem } from './listen-guard.mjs'

const CONFIG = fileURLToPath(new URL('../workerd.config.capnp', import.meta.url))
export const DEFAULT_ADDRESS = '127.0.0.1:8080'

/**
 * @param {{address?: string, env?: Record<string, string|undefined>}} [opts]
 * @returns {{command: string, args: string[], env: Record<string, string|undefined>}}
 * @throws {Error} naming the reason when the address needs a token and there is none.
 */
export function buildServeCommand({ address = DEFAULT_ADDRESS, env = process.env } = {}) {
  const problem = controlAuthProblem({ address, token: env.CONTROL_TOKEN })
  if (problem) throw new Error(`refusing to start: ${problem}`)
  return {
    command: 'workerd',
    args: ['serve', CONFIG, `--socket-addr=http=${address}`],
    env: { ...env, LISTEN_ADDRESS: address },
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const at = process.argv.indexOf('--address')
  try {
    const { command, args, env } = buildServeCommand({ address: at === -1 ? undefined : process.argv[at + 1] })
    spawn(command, args, { env, stdio: 'inherit' }).on('exit', (code) => process.exit(code ?? 1))
  } catch (err) {
    process.stderr.write(`${err.message}\n`)
    process.exit(1)
  }
}
