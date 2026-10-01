/**
 * cli.mjs — `meshctl`'s `main()`, the one function `bin/meshctl.mjs` calls
 * and `test/helpers.mjs`'s `runCli()` calls in-process.
 *
 * Every command group funnels through `main()` -> `dispatch()`:
 *   - `identity` and `vm` never touch the mesh (see `commands.mjs`'s and
 *     `vm-bridge.mjs`'s own doc comments for why).
 *   - `hosts`, `host describe`, `pods *`, `watch` all need a connected
 *     `MeshctlSession` (`connect.mjs`) first, built from `--loopback` or
 *     `--signaling`, and torn down in a `finally` whether the command
 *     succeeded or not.
 *
 * `main()` is the ENTIRE JSON-first output contract in one place: parse
 * argv (`args.mjs`), run the command, print exactly one `{ok, result}` or
 * `{ok: false, error}` document (`output.mjs`), return an exit code --
 * never `process.exit()` itself, so tests can call it in-process and read
 * `process.exitCode`-equivalent as a return value instead of forking.
 */

import {
  EXIT_CODE, UsageError, resolveFormat, formatDocument, okEnvelope, errorEnvelope, exitCodeForError,
  createLogger,
} from './output.mjs'
import { parseCommand } from './args.mjs'
import { DEFAULT_IDENTITY_PATH, loadOrCreateIdentity } from './identity.mjs'
import { connect } from './connect.mjs'
import {
  cmdHosts, cmdHostDescribe, cmdPodsList, cmdPodsSpawn, cmdPodsStatus, cmdPodsSend, cmdPodsExec,
  cmdPodsSnapshot, cmdPodsRestore, cmdPodsDrain, cmdWatch,
} from './commands.mjs'
import { runVmCommand, VM_COMMANDS } from './vm-bridge.mjs'

/** `meshctl --help`'s JSON usage document. */
function usageDocument() {
  return {
    name: 'meshctl',
    description: 'External CLI for the browsermesh hosted-pods control surface (issue #185 item 5). '
      + 'meshctl is itself a pod: it boots its own mesh identity, joins the mesh, and issues the same '
      + 'pod-host:request envelopes the in-mesh client uses -- there is no separate admin API.',
    globalFlags: {
      '--loopback': 'connect via an in-process mesh with its own hosts (tests/examples/dev)',
      '--signaling <ws://...>': 'connect to a real mesh via this signaling server',
      '--relay <ws://...>': 'optional relay fallback transport, used with --signaling',
      '--identity <file>': `identity file path (default: ${DEFAULT_IDENTITY_PATH})`,
      '--host <ref>': 'a known host pubKey (repeatable); required for hosts/pods spawn auto in real mode',
      '--timeout <ms>': 'pod-host request timeout in ms (default: 10000)',
      '--json': 'force compact JSON output',
      '--pretty': 'force pretty-printed JSON output',
      '--quiet': 'suppress stderr diagnostics',
      '--help, -h': 'print this document and exit 0',
    },
    commands: [
      'identity',
      'hosts',
      'host describe <host>',
      'pods list <host>',
      'pods spawn <host|auto> --name <n> --lane <l> --kind skill|module|rootfs|command --ref <r> '
        + '[--entry <e>] [--input <json>] [--limits <json>] [--caps a,b] [--env K=V...] '
        + '[--restart never|on-failure|always] [--spec <file.json>]',
      'pods status <host> <name>',
      'pods send <host> <name> --payload <json> [--to <podId>]',
      'pods exec <host> <name> -- <argv...>',
      'pods snapshot <host> <name>',
      'pods restore <host> <name>',
      'pods drain <host> <name> [--cascade]',
      'watch <host>',
      'vm spawn <name> --dry-run [--kernel <path>] [--rootfs <path>]',
      'vm exec <name> -- <argv...> --dry-run',
      'vm snapshot <name> --dry-run',
      'vm restore <name> --dry-run',
      'vm drain <name> --dry-run',
      'vm status',
    ],
    exitCodes: EXIT_CODE,
    note: '`vm` talks to a LOCAL VmPodHost directly (no mesh connection); `pods`/`hosts`/`watch` go over the mesh.',
  }
}

/**
 * @param {string} cmd
 * @param {import('./connect.mjs').MeshctlSession} session
 * @param {{positionals: string[], flags: object, rest: string[]}} parsed
 */
function dispatchPods(cmd, session, parsed) {
  switch (cmd) {
    case 'list': return cmdPodsList(session, parsed)
    case 'spawn': return cmdPodsSpawn(session, parsed)
    case 'status': return cmdPodsStatus(session, parsed)
    case 'send': return cmdPodsSend(session, parsed)
    case 'exec': return cmdPodsExec(session, parsed)
    case 'snapshot': return cmdPodsSnapshot(session, parsed)
    case 'restore': return cmdPodsRestore(session, parsed)
    case 'drain': return cmdPodsDrain(session, parsed)
    default:
      throw new UsageError(`pods: unknown subcommand '${cmd}' `
        + '(expected one of list|spawn|status|send|exec|snapshot|restore|drain)')
  }
}

/**
 * @param {import('./args.mjs').ParsedCommand} parsed
 * @param {object} ctx
 * @param {{write: Function}} ctx.stdout
 * @param {(msg: string) => void} ctx.log
 * @param {AbortSignal} [ctx.signal]
 * @param {Function} [ctx.WebSocketCtor]
 * @returns {Promise<*>}
 */
async function dispatch(parsed, ctx) {
  const { group, cmd, positionals, flags, rest } = parsed

  if (group === 'identity') {
    const identityPath = flags.identity || DEFAULT_IDENTITY_PATH
    const identity = await loadOrCreateIdentity({
      identityPath, label: typeof flags.label === 'string' ? flags.label : undefined,
    })
    return {
      podId: identity.podId, label: identity.label, identityPath: identity.identityPath, created: identity.created,
    }
  }

  if (group === 'vm') {
    if (!VM_COMMANDS.includes(cmd)) {
      throw new UsageError(`vm: unknown subcommand '${cmd}' (expected one of ${VM_COMMANDS.join('|')})`)
    }
    return runVmCommand({
      command: cmd,
      name: positionals[0],
      argv: rest,
      dryRun: flags['dry-run'] === true,
      kernel: typeof flags.kernel === 'string' ? flags.kernel : undefined,
      rootfs: typeof flags.rootfs === 'string' ? flags.rootfs : undefined,
      onLog: ctx.log,
    })
  }

  // Everything below needs a connected mesh session. A real invocation
  // (or a loopback one meant to stand alone) builds and tears down its own
  // via `connect()` -- `--loopback`'s hosts are an `InMemoryPodHostDriver`
  // that lives only as long as THIS process, so there is no way for a
  // second `meshctl` invocation to see a pod the first one spawned, and
  // that's by design (see `loopback.mjs`'s header). `ctx.session`, settable
  // only by `main()`'s own `io.session` (never by a CLI flag -- there is no
  // `--session`), lets `test/helpers.mjs` drive several commands against
  // ONE still-open loopback (or fake-real) session in-process, the way an
  // embedder holding `meshctl` open across several `main()` calls would --
  // the session is then the CALLER's to close, not this function's.
  let session = ctx.session
  let ownsSession = false
  if (!session) {
    const identityPath = flags.identity || DEFAULT_IDENTITY_PATH
    const cliIdentity = await loadOrCreateIdentity({
      identityPath, label: typeof flags.label === 'string' ? flags.label : undefined,
    })
    const timeoutMs = flags.timeout !== undefined ? Number(flags.timeout) : undefined
    session = await connect({
      flags, cliIdentity, timeoutMs, onLog: ctx.log, WebSocketCtor: ctx.WebSocketCtor,
    })
    ownsSession = true
  }

  try {
    if (group === 'hosts') return await cmdHosts(session, { flags })
    if (group === 'host') {
      if (cmd !== 'describe') throw new UsageError(`host: unknown subcommand '${cmd}' (expected 'describe')`)
      return await cmdHostDescribe(session, { positionals })
    }
    if (group === 'pods') return await dispatchPods(cmd, session, { positionals, flags, rest })
    if (group === 'watch') {
      return await cmdWatch(session, { positionals }, {
        writeLine: (line) => ctx.stdout.write(`${line}\n`),
        signal: ctx.signal,
      })
    }
    throw new UsageError(`unknown command '${group}${cmd ? ` ${cmd}` : ''}'`)
  } finally {
    if (ownsSession) await session.close()
  }
}

/**
 * @param {string[]} argv - `process.argv.slice(2)`-shaped.
 * @param {object} [io]
 * @param {{write: Function, isTTY?: boolean}} [io.stdout]
 * @param {{write: Function}} [io.stderr]
 * @param {AbortSignal} [io.signal] - Aborts `watch`; `bin/meshctl.mjs` wires SIGINT to this.
 * @param {Function} [io.WebSocketCtor] - Injectable `WebSocket`, for tests of the real-mesh path.
 * @param {import('./connect.mjs').MeshctlSession} [io.session] - Test-only: reuse an
 *   already-connected session instead of building (and closing) a fresh one -- see
 *   `dispatch()`'s own comment on why `--loopback` otherwise can't share pod state
 *   across separate `main()` calls. Never set by a CLI flag.
 * @returns {Promise<number>} An `EXIT_CODE` value.
 */
export async function main(argv, io = {}) {
  const stdout = io.stdout || process.stdout
  const stderr = io.stderr || process.stderr

  let parsed
  try {
    parsed = parseCommand(argv)
  } catch (err) {
    const format = resolveFormat({ stream: stdout })
    stderr.write(`${formatDocument(errorEnvelope(err), format)}\n`)
    return exitCodeForError(err.code)
  }

  const format = resolveFormat({ json: parsed.flags.json, pretty: parsed.flags.pretty, stream: stdout })

  if (parsed.help) {
    stdout.write(`${formatDocument(okEnvelope(usageDocument()), format)}\n`)
    return EXIT_CODE.OK
  }

  const log = createLogger({ quiet: parsed.flags.quiet, stream: stderr })

  // `createPodHostClient()`'s own per-request timeout timer is deliberately
  // UNREF'd ("never hold a Node process open for an in-flight request" --
  // its own doc comment, correct for a long-lived mesh node whose client
  // shouldn't itself keep the process alive). `meshctl` is the opposite
  // case: a short-lived CLI that is NOTHING BUT an in-flight request --
  // over `--loopback`'s in-memory transport there may be no other ref'd
  // handle at all, so without this, a request to an unresponsive host can
  // let the event loop go idle and exit before that unref'd timer ever
  // fires, silently dropping the `ETIMEDOUT` this command was supposed to
  // report. A trivial ref'd ticker for the lifetime of one dispatch is
  // cheap insurance against exactly that.
  const keepAlive = setInterval(() => {}, 60_000)
  try {
    const result = await dispatch(parsed, {
      stdout, log, signal: io.signal, WebSocketCtor: io.WebSocketCtor, session: io.session,
    })
    stdout.write(`${formatDocument(okEnvelope(result), format)}\n`)
    return EXIT_CODE.OK
  } catch (err) {
    stderr.write(`${formatDocument(errorEnvelope(err), format)}\n`)
    return exitCodeForError(err && err.code)
  } finally {
    clearInterval(keepAlive)
  }
}
