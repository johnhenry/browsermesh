/**
 * commands.mjs — the `hosts`/`host describe`/`pods *`/`watch` command
 * handlers: the mesh-connected half of `meshctl`'s command grammar.
 *
 * Every handler here takes `(session, parsed)` -- `session` is a
 * `connect.mjs` `MeshctlSession` (loopback or real, already connected),
 * `parsed` is `{positionals, flags, rest}` from `args.mjs`. Each returns a
 * plain JSON-serializable value, which `cli.mjs` wraps as `{ok: true,
 * result}` and prints -- these functions never touch stdout/stderr
 * themselves (except `watch`, which streams NDJSON through the `writeLine`
 * callback `cli.mjs` hands it, by design -- see its own doc comment).
 *
 * None of this re-implements access control, validation, or the verb
 * dispatch: every call here is a thin pass-through to
 * `createPodHostClient()` (`@johnhenry/browsermesh-apps`), exactly as
 * `docs/hosted-pods.md` §8a's "everything else is a projection" describes.
 */

import { readFile } from 'node:fs/promises'
import { UsageError } from './output.mjs'
import { validatePodSpec } from '@johnhenry/browsermesh-pod'
import { selectAutoHost } from './auto-placement.mjs'

/** @param {*} value @returns {string[]} */
function asArray(value) {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

/**
 * @param {string} raw
 * @param {string} flagLabel - For the error message, e.g. `'--input'`.
 * @returns {*}
 */
function parseJsonFlag(raw, flagLabel) {
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new UsageError(`${flagLabel} must be valid JSON: ${err.message}`)
  }
}

/**
 * @param {string[]} positionals
 * @param {number} index
 * @param {string} cmdLabel
 * @returns {string}
 */
function requirePositional(positionals, index, cmdLabel, what = '<host>') {
  const value = positionals[index]
  if (!value) throw new UsageError(`${cmdLabel}: ${what} is required`)
  return value
}

/**
 * Resolve a `<host>` CLI argument to a pubKey and make sure a session to it
 * exists (a no-op in loopback mode; negotiates WebRTC in real mode -- see
 * `connect.mjs`'s `MeshctlSession.ensureConnected`).
 *
 * @param {import('./connect.mjs').MeshctlSession} session
 * @param {string} ref
 * @returns {Promise<string>} The host's pubKey.
 */
async function resolveAndConnect(session, ref) {
  const resolved = session.resolveHost(ref)
  const podId = resolved ? resolved.podId : ref
  await session.ensureConnected(podId)
  return podId
}

/**
 * The candidate host list for commands that consider every known host
 * (`hosts`, `pods spawn auto`): the session's own known hosts (loopback:
 * the ones it created) plus every `--host` flag, deduplicated.
 *
 * @param {import('./connect.mjs').MeshctlSession} session
 * @param {object} flags
 * @returns {string[]}
 */
function candidateHostRefs(session, flags) {
  return [...new Set([...session.knownHosts(), ...asArray(flags.host)])]
}

// ---------------------------------------------------------------------------
// hosts / host describe
// ---------------------------------------------------------------------------

/**
 * `meshctl hosts` -- describe every known host.
 * @param {import('./connect.mjs').MeshctlSession} session
 * @param {{flags: object}} parsed
 * @returns {Promise<object[]>}
 */
export async function cmdHosts(session, { flags }) {
  const refs = candidateHostRefs(session, flags)
  if (refs.length === 0) {
    throw new UsageError(
      'hosts: no known hosts -- pass --host <pubKey> at least once (real mesh), or use --loopback',
    )
  }
  const results = []
  for (const ref of refs) {
    let podId
    try {
      podId = await resolveAndConnect(session, ref)
      const description = await session.client.describe(podId)
      results.push({
        host: podId,
        lane: description.lane,
        verbs: description.verbs,
        runtimeClasses: description.runtimeClasses,
        shellBackend: description.shellBackend,
        deploymentSupport: description.deploymentSupport,
      })
    } catch (err) {
      results.push({ host: podId || ref, error: { code: err.code || 'EUNKNOWN', message: err.message } })
    }
  }
  return results
}

/**
 * `meshctl host describe <host>`.
 * @param {import('./connect.mjs').MeshctlSession} session
 * @param {{positionals: string[]}} parsed
 * @returns {Promise<object>}
 */
export async function cmdHostDescribe(session, { positionals }) {
  const ref = requirePositional(positionals, 0, 'host describe')
  const podId = await resolveAndConnect(session, ref)
  return session.client.describe(podId)
}

// ---------------------------------------------------------------------------
// pods spawn's podspec assembly
// ---------------------------------------------------------------------------

/**
 * Assemble a podspec from `pods spawn`'s flags. `--spec <file.json>` reads
 * a complete (or partial) podspec from disk first; every other flag then
 * overrides the matching key, so `--spec base.json --env LOG_LEVEL=debug`
 * layers a one-off override onto a saved spec without editing the file.
 *
 * @param {object} flags
 * @returns {Promise<object>} An UNVALIDATED podspec -- `createPodHostClient
 *   ().spawn()` sends it as-is; the host's `validateVerbRequest()` is the
 *   single source of truth for what's actually valid, so this does not
 *   duplicate that validation.
 */
export async function buildPodSpec(flags) {
  /** @type {Record<string, *>} */
  let spec = {}
  if (flags.spec !== undefined) {
    let raw
    try {
      raw = await readFile(flags.spec, 'utf8')
    } catch (err) {
      throw new UsageError(`--spec '${flags.spec}': ${err.message}`)
    }
    try {
      spec = JSON.parse(raw)
    } catch (err) {
      throw new UsageError(`--spec '${flags.spec}' is not valid JSON: ${err.message}`)
    }
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new UsageError(`--spec '${flags.spec}' must contain a JSON object`)
    }
    spec = { ...spec }
  }

  if (flags.name !== undefined) spec.name = flags.name
  if (flags.lane !== undefined) spec.lane = flags.lane

  if (flags.kind !== undefined || flags.ref !== undefined || flags.entry !== undefined || flags.input !== undefined) {
    spec.run = { ...(spec.run || {}) }
    if (flags.kind !== undefined) spec.run.kind = flags.kind
    if (flags.ref !== undefined) spec.run.ref = flags.ref
    if (flags.entry !== undefined) spec.run.entry = flags.entry
    if (flags.input !== undefined) spec.run.input = parseJsonFlag(flags.input, '--input')
  }

  if (flags.limits !== undefined) spec.limits = parseJsonFlag(flags.limits, '--limits')
  if (flags.caps !== undefined) {
    spec.caps = String(flags.caps).split(',').map((s) => s.trim()).filter(Boolean)
  }
  if (flags.env !== undefined) {
    spec.env = { ...(spec.env || {}) }
    for (const kv of asArray(flags.env)) {
      const eq = kv.indexOf('=')
      if (eq === -1) throw new UsageError(`--env '${kv}' must be KEY=VALUE`)
      spec.env[kv.slice(0, eq)] = kv.slice(eq + 1)
    }
  }
  if (flags.restart !== undefined) spec.restart = { policy: flags.restart }

  return spec
}

// ---------------------------------------------------------------------------
// pods
// ---------------------------------------------------------------------------

/**
 * `meshctl pods list <host>`.
 * @param {import('./connect.mjs').MeshctlSession} session
 * @param {{positionals: string[]}} parsed
 */
export async function cmdPodsList(session, { positionals }) {
  const ref = requirePositional(positionals, 0, 'pods list')
  const podId = await resolveAndConnect(session, ref)
  return session.client.list(podId)
}

/**
 * `meshctl pods spawn <host|auto> --name ... --lane ... --kind ... --ref ...`.
 * @param {import('./connect.mjs').MeshctlSession} session
 * @param {{positionals: string[], flags: object}} parsed
 */
export async function cmdPodsSpawn(session, { positionals, flags }) {
  const ref = requirePositional(positionals, 0, 'pods spawn')
  let spec = await buildPodSpec(flags)

  if (ref === 'auto') {
    // Let the protocol's own normalization infer the lane from run.kind
    // (skill/module -> isolate, command/rootfs -> microvm) before insisting
    // on --lane; the explicit flag still wins when given.
    const normalized = validatePodSpec(spec)
    if (normalized.ok) spec = normalized.value
    if (!spec.lane) throw new UsageError('pods spawn auto: --lane is required to select a host (or give --kind so it can be inferred)')
    const refs = candidateHostRefs(session, flags)
    const picked = await selectAutoHost({ session, candidateRefs: refs, lane: spec.lane })
    const pod = await session.client.spawn(picked.podId, spec)
    return { host: picked.podId, chosenVia: picked.via, pod }
  }

  const podId = await resolveAndConnect(session, ref)
  const pod = await session.client.spawn(podId, spec)
  return { host: podId, pod }
}

/**
 * `meshctl pods status <host> <name>`.
 */
export async function cmdPodsStatus(session, { positionals }) {
  const ref = requirePositional(positionals, 0, 'pods status')
  const name = requirePositional(positionals, 1, 'pods status', '<name>')
  const podId = await resolveAndConnect(session, ref)
  return session.client.status(podId, name)
}

/**
 * `meshctl pods send <host> <name> --payload <json> [--to <podId>]`.
 */
export async function cmdPodsSend(session, { positionals, flags }) {
  const ref = requirePositional(positionals, 0, 'pods send')
  const name = requirePositional(positionals, 1, 'pods send', '<name>')
  if (flags.payload === undefined) throw new UsageError('pods send: --payload <json> is required')
  const payload = parseJsonFlag(flags.payload, '--payload')
  const podId = await resolveAndConnect(session, ref)
  return session.client.send(podId, name, payload, flags.to !== undefined ? { to: flags.to } : {})
}

/**
 * `meshctl pods exec <host> <name> -- <argv...>`.
 */
export async function cmdPodsExec(session, { positionals, rest }) {
  const ref = requirePositional(positionals, 0, 'pods exec')
  const name = requirePositional(positionals, 1, 'pods exec', '<name>')
  if (!rest || rest.length === 0) throw new UsageError('pods exec: pass the command after --')
  const podId = await resolveAndConnect(session, ref)
  return session.client.exec(podId, name, rest)
}

/**
 * `meshctl pods snapshot <host> <name>`.
 */
export async function cmdPodsSnapshot(session, { positionals }) {
  const ref = requirePositional(positionals, 0, 'pods snapshot')
  const name = requirePositional(positionals, 1, 'pods snapshot', '<name>')
  const podId = await resolveAndConnect(session, ref)
  return session.client.snapshot(podId, name)
}

/**
 * `meshctl pods restore <host> <name>`.
 */
export async function cmdPodsRestore(session, { positionals }) {
  const ref = requirePositional(positionals, 0, 'pods restore')
  const name = requirePositional(positionals, 1, 'pods restore', '<name>')
  const podId = await resolveAndConnect(session, ref)
  return session.client.restore(podId, name)
}

/**
 * `meshctl pods drain <host> <name> [--cascade]`.
 */
export async function cmdPodsDrain(session, { positionals, flags }) {
  const ref = requirePositional(positionals, 0, 'pods drain')
  const name = requirePositional(positionals, 1, 'pods drain', '<name>')
  const podId = await resolveAndConnect(session, ref)
  return session.client.drain(podId, name, { cascade: flags.cascade === true })
}

// ---------------------------------------------------------------------------
// supervise / supervised / crash (issue #185 item 6)
// ---------------------------------------------------------------------------

/**
 * `meshctl pods supervise <host|auto> --name ... --kind ... --ref ... `
 * `[--restart never|on-failure|always] [--max-restarts n] [--backoff ms] [--parent name]`.
 *
 * Same podspec assembly as `pods spawn` (`buildPodSpec()`), plus the
 * restart/links knobs: `session.getSupervisor()` is a `PodSupervisor`
 * (`@johnhenry/browsermesh-apps`) kept alive for the life of this
 * `MeshctlSession` -- it only keeps restarting the pod while THIS process
 * (or, in tests, this in-process session) stays open; see `connect.mjs`'s
 * `withSupervisor()`.
 * @param {import('./connect.mjs').MeshctlSession} session
 * @param {{positionals: string[], flags: object}} parsed
 */
export async function cmdPodsSupervise(session, { positionals, flags }) {
  const ref = requirePositional(positionals, 0, 'pods supervise')
  let spec = await buildPodSpec(flags)
  if (flags['max-restarts'] !== undefined || flags.backoff !== undefined || flags.restart !== undefined) {
    spec.restart = {
      policy: flags.restart || 'never',
      ...(flags['max-restarts'] !== undefined ? { maxRestarts: Number(flags['max-restarts']) } : {}),
      ...(flags.backoff !== undefined ? { backoffMs: Number(flags.backoff) } : {}),
    }
  }
  if (flags.parent !== undefined) spec.links = { ...(spec.links || {}), parent: flags.parent }

  const supervisor = await session.getSupervisor()

  if (ref === 'auto') {
    const normalized = validatePodSpec(spec)
    if (normalized.ok) spec = normalized.value
    if (!spec.lane) throw new UsageError('pods supervise auto: --lane is required to select a host (or give --kind so it can be inferred)')
    const refs = candidateHostRefs(session, flags)
    const picked = await selectAutoHost({ session, candidateRefs: refs, lane: spec.lane })
    const { ref: podRef, host, status } = await supervisor.supervise(picked.podId, spec)
    return { host, chosenVia: picked.via, ref: podRef, pod: status }
  }

  const podId = await resolveAndConnect(session, ref)
  const { ref: podRef, host, status } = await supervisor.supervise(podId, spec)
  return { host, ref: podRef, pod: status }
}

/**
 * `meshctl pods supervised` -- list every pod `session.getSupervisor()` is
 * tracking.
 * @param {import('./connect.mjs').MeshctlSession} session
 */
export async function cmdPodsSupervised(session) {
  const supervisor = await session.getSupervisor()
  return supervisor.list()
}

/**
 * `meshctl pods crash <host> <name> [--code n]` -- DEV-ONLY demo path:
 * forces a loopback host's `InMemoryPodHostDriver` straight to `gone` with
 * `reason: 'crashed'` (`host-protocol.mjs`'s test-only `crash()`), to show
 * a supervised pod's restart policy actually fire without waiting for a
 * real process to fail. Refuses outright in `mode: 'real'` -- there is no
 * wire verb for this (a real host cannot be told "pretend you crashed"),
 * and it would be a safety footgun to let an operator even try.
 * @param {import('./connect.mjs').MeshctlSession} session
 * @param {{positionals: string[], flags: object}} parsed
 */
export async function cmdPodsCrash(session, { positionals, flags }) {
  const ref = requirePositional(positionals, 0, 'pods crash')
  const name = requirePositional(positionals, 1, 'pods crash', '<name>')
  if (session.mode !== 'loopback' || typeof session.loopbackDriverFor !== 'function') {
    throw new UsageError('pods crash: only available over --loopback (dev-only demo of a supervised restart)')
  }
  const driver = session.loopbackDriverFor(ref)
  if (!driver) throw new UsageError(`pods crash: unknown loopback host '${ref}'`)
  const code = flags.code !== undefined ? Number(flags.code) : undefined
  return driver.crash(name, code !== undefined ? { code } : {})
}

// ---------------------------------------------------------------------------
// watch
// ---------------------------------------------------------------------------

/**
 * `meshctl watch <host>` -- stream `pod-host:event`s as NDJSON until
 * `signal` aborts (SIGINT in the real bin -- see `cli.mjs`).
 *
 * A host only forwards events for pods a requester has shown "interest"
 * in by naming them in some prior request (`pod-host-service.mjs`'s
 * `noteInterest()`) -- there is no "subscribe to every pod on this host"
 * primitive on the wire. `watch` works around that by polling `list()`
 * every `pollMs` and calling `status()` on any pod name it hasn't seen
 * yet, which is enough to register interest without changing the pod's
 * state. Pods that come and go between polls, faster than `pollMs`, can
 * still be missed; `pollMs` trades that risk against poll traffic.
 *
 * @param {import('./connect.mjs').MeshctlSession} session
 * @param {{positionals: string[]}} parsed
 * @param {object} io
 * @param {(line: string) => void} io.writeLine
 * @param {AbortSignal} [io.signal]
 * @param {number} [io.pollMs=250]
 * @returns {Promise<{stopped: true, events: number}>}
 */
/** Every event `PodSupervisor#on()` (`pod-supervisor.mjs`) emits -- there is no wildcard subscription, so `watch` subscribes to each by name. */
const SUPERVISOR_EVENT_NAMES = Object.freeze([
  'supervisor:restart-scheduled', 'supervisor:restarted', 'supervisor:gave-up',
  'supervisor:cascade', 'supervisor:host-lost',
])

export async function cmdWatch(session, { positionals }, { writeLine, signal, pollMs = 250 }) {
  const ref = requirePositional(positionals, 0, 'watch')
  const podId = await resolveAndConnect(session, ref)

  let eventCount = 0
  const unsubscribe = session.client.onEvent((hostPubKey, event) => {
    if (hostPubKey !== podId) return
    eventCount += 1
    writeLine(JSON.stringify({ host: hostPubKey, kind: event.kind, data: event.data, ts: event.ts }))
  })

  // Also print this session's own supervisor activity (issue #185 item 6),
  // scoped to pods supervised on THIS host -- a supervisor's restart is a
  // local decision this session made, not a wire event the host sent, so
  // it is a separate subscription rather than something `session.client
  // .onEvent()` could ever see.
  const supervisor = await session.getSupervisor()
  const unsubscribeSupervisor = SUPERVISOR_EVENT_NAMES.map((name) => supervisor.on(name, (data) => {
    const host = data.host || data.ref?.host || data.parent?.host
    if (host !== podId) return
    eventCount += 1
    writeLine(JSON.stringify({ host: podId, kind: name, data, ts: Date.now() }))
  }))

  const seen = new Set()
  async function registerInterest() {
    let pods
    try {
      pods = await session.client.list(podId)
    } catch {
      return // transient -- keep watching, try again next poll
    }
    for (const pod of pods) {
      if (seen.has(pod.name)) continue
      seen.add(pod.name)
      await session.client.status(podId, pod.name).catch(() => {})
    }
  }

  await registerInterest()
  const timer = setInterval(() => { registerInterest().catch(() => {}) }, pollMs)
  if (typeof timer.unref === 'function') timer.unref()

  await new Promise((resolve) => {
    if (!signal || signal.aborted) { resolve(); return }
    signal.addEventListener('abort', () => resolve(), { once: true })
  })

  clearInterval(timer)
  unsubscribe()
  for (const off of unsubscribeSupervisor) off()
  return { stopped: true, events: eventCount }
}
