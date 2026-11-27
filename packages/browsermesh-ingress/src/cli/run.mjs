/**
 * run.mjs -- `browsermesh-ingress`: parse, check, start the mesh node, start the listener, say what it serves.
 *
 * `main` returns an exit code when the process should end (`--help`, bad input, a node that cannot start) and
 * `null` once the listener is up, so the open server keeps the process alive.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createMeshIngress } from '../ingress.mjs'
import { applyForcedHeaders, hostName } from '../headers.mjs'
import { NAMES_PROTOCOL, createNameTable, registryAllow, serveIngressNames } from '../names.mjs'
import { listenNode } from '../node.mjs'
import { UsageError, USAGE, createResolver, fromConfig, merge, parseArgv, resolveOptions } from './args.mjs'
import { MeshStartError, startMeshNode } from './mesh-node.mjs'

const digest = (s) => createHash('sha256').update(s).digest()

export function bearerDeny(token) {
  const wanted = digest(`Bearer ${token}`)
  return (request) => {
    const given = request.headers.get('authorization')
    if (given !== null && timingSafeEqual(digest(given), wanted)) return null
    const headers = new Headers({ 'content-type': 'text/plain; charset=utf-8', 'www-authenticate': 'Bearer' })
    applyForcedHeaders(headers)
    return new Response('A bearer token is required.\n', { status: 401, headers })
  }
}

/**
 * @param {string[]} argv
 * @param {{ env?: object, stdout: { write(s: string): any }, stderr: { write(s: string): any }, startNode?: Function, process?: object }} io
 * @returns {Promise<number|null>}
 */
export async function main(argv, { stdout, stderr, startNode = startMeshNode, process: proc = process } = {}) {
  const say = (s) => stdout.write(`${s}\n`)
  const warn = (s) => stderr.write(`${s}\n`)
  let options
  let token = null
  try {
    const flags = parseArgv(argv)
    if (flags.help) { stdout.write(USAGE); return 0 }
    let config = { map: [] }
    if (flags.config) {
      let text
      try { text = await readFile(flags.config, 'utf8') } catch (e) { throw new UsageError(`Cannot read the config file ${flags.config}: ${e.code ?? e.message}.`) }
      let json
      try { json = JSON.parse(text) } catch { throw new UsageError(`The config file ${flags.config} is not valid JSON.`) }
      config = fromConfig(json)
    }
    options = resolveOptions(merge(config, flags))
    if (options.auth) {
      let text
      try { text = await readFile(options.auth.file, 'utf8') } catch (e) { throw new UsageError(`Cannot read the token file ${options.auth.file}: ${e.code ?? e.message}.`) }
      token = text.trim()
      if (token.length < 16 || /\s/.test(token)) throw new UsageError(`The token in ${options.auth.file} must be one word of at least 16 characters.`)
    }
  } catch (e) {
    if (e instanceof UsageError) { warn(`browsermesh-ingress: ${e.message}`); return 2 }
    throw e
  }
  for (const w of options.warnings) warn(`browsermesh-ingress: ${w}`)

  let mesh
  try {
    mesh = await startNode({ signaling: options.signaling, identityPath: options.identity })
  } catch (e) {
    warn(`browsermesh-ingress: cannot start the mesh node: ${e instanceof MeshStartError ? e.message : (e?.message ?? e)}`)
    return 1
  }

  const limits = {}
  if (options.maxBody) limits.maxRequestBodyBytes = options.maxBody
  if (options.timeoutMs) limits.timeoutMs = options.timeoutMs
  if (options.uploadTimeoutMs) limits.uploadTimeoutMs = options.uploadTimeoutMs
  if (options.maxUploads) limits.maxUploadsPerProvider = options.maxUploads
  if (options.uploadQueueMs !== undefined) limits.uploadQueueMs = options.uploadQueueMs
  if (options.uploadQueueMax !== undefined) limits.uploadQueueMax = options.uploadQueueMax
  const waiting = options.linkWaitMs !== 0
  if (options.linkWaitMs) limits.linkWaitMs = options.linkWaitMs

  // Names pods may claim: off unless the operator gave a zone. The grants are the operator's, written into the node's registry in
  // the family's notation (`protocol:ingress-names:open`, `ingress:name:<label>:claim`); nothing else can claim anything.
  let names = null
  let namesServed = null
  if (options.names) {
    const registry = mesh.node?.registry
    if (typeof registry?.grantCapabilities !== 'function') {
      warn('browsermesh-ingress: cannot start names: this mesh node has no registry to hold the grants.')
      await mesh.close()
      return 1
    }
    for (const { pod, labels } of options.names.allow) registry.grantCapabilities(pod, [`protocol:${NAMES_PROTOCOL}:open`, ...labels.map((l) => `ingress:name:${l}:claim`)])
    const mapped = new Set(options.mappings.map((m) => hostName(m.host)))
    names = createNameTable({
      zone: options.names.zone,
      allow: registryAllow(registry),
      deny: options.names.deny,
      ...(options.names.maxNames ? { maxNames: options.names.maxNames } : {}),
      ...(options.names.maxPerPod ? { maxPerPod: options.names.maxPerPod } : {}),
      ...(options.names.holdMs !== undefined ? { holdMs: options.names.holdMs } : {}),
      reserved: (host) => mapped.has(host),
      onAudit: (r) => say(`name ${r.action} ${r.name}.${options.names.zone} ${r.action === 'claim' || r.action === 'refuse' ? '<-' : 'of'} ${r.pod}${r.reason ? ` (${r.reason})` : ''}`),
    })
    namesServed = serveIngressNames(mesh.service, names)
  }

  const ingress = createMeshIngress({
    service: mesh.service,
    resolve: createResolver(options.mappings),
    ...(names ? { names } : {}),
    methods: options.methods,
    limits,
    deny: token ? bearerDeny(token) : undefined,
    onAudit: (r) => say(`${r.method} ${r.host} -> ${r.peer ?? '-'}${r.service ? `#${r.service}` : ''} ${r.status}${r.reason ? ` (${r.reason})` : ''} in ${r.requestBytes}B out ${r.responseBytes}B ${r.durationMs}ms`),
  })
  // The mapped pods are dialled now and kept dialled; a request that arrives before a link is up waits for it (bounded)
  // instead of being answered 502.
  if (waiting) for (const peer of new Set(options.mappings.map((m) => m.peer))) ingress.expect(peer, { retryMs: 250 })
  let listener
  try {
    listener = await listenNode(ingress, { host: options.host, port: options.port, public: options.public, trustProxy: false, requestTimeoutMs: Math.max(300_000, limits.uploadTimeoutMs ?? 0), ...(options.readyPath ? { readyPath: options.readyPath } : {}) })
  } catch (e) {
    namesServed?.stop()
    await ingress.close()
    await mesh.close()
    warn(`browsermesh-ingress: cannot listen on ${options.host}:${options.port}: ${e?.code ?? e?.message}`)
    return 1
  }

  say(`browsermesh-ingress pod id: ${mesh.podId}${mesh.created ? ' (new identity)' : ''}`)
  for (const mp of options.mappings) say(`serving ${mp.host}${mp.prefix} -> ${mp.peer}${mp.service ? ` (service ${mp.service})` : ''}`)
  if (names) say(`names: claimable under *.${options.names.zone} by ${options.names.allow.length} pod${options.names.allow.length === 1 ? '' : 's'}`)
  if (options.readyPath) say(`readiness: GET ${options.readyPath}`)
  say(`methods: ${options.methods === '*' ? 'every method (not CONNECT, TRACE or TRACK)' : options.methods.join(', ')}; body cap ${(limits.maxRequestBodyBytes ?? 32 * 1024 * 1024) === Infinity ? 'none' : `${limits.maxRequestBodyBytes ?? 32 * 1024 * 1024} bytes`}; auth: ${token ? 'bearer token required' : 'none'}`)
  say(`listening on http://${options.host.includes(':') ? `[${options.host}]` : options.host}:${listener.port}`)

  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    await listener.close()
    namesServed?.stop()
    await ingress.close()
    await mesh.close()
    proc.exit?.(0)
  }
  proc.once?.('SIGINT', stop)
  proc.once?.('SIGTERM', stop)
  return null
}
