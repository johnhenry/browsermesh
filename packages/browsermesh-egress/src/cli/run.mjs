/**
 * run.mjs -- `browsermesh-egress`: parse, check, say what would be allowed (`--dry-run`) or start the mesh node and the provider,
 * grant, and print the audit lines.
 *
 * `main` returns an exit code when the process should end (`--help`, `--dry-run`, bad input, a node that cannot start) and
 * `null` once the provider is serving, so the open node keeps the process alive until a signal ends it.
 */
import { readFile } from 'node:fs/promises'
import { createMeshEgress } from '../provider.mjs'
import { UsageError, USAGE, describeGrants, fromConfig, merge, parseArgv, resolveOptions } from './args.mjs'
import { MeshStartError, startMeshNode } from './mesh-node.mjs'

const OPEN = 'protocol:egress:open'

/** One audit record as a line: `time event key=value ...`, `host` and `port` joined as `dest`. Never a payload (the provider carries none). */
export function formatAudit(record) {
  const { at, event, host, port, ...rest } = record
  const parts = [new Date(at ?? Date.now()).toISOString(), event]
  if (host !== undefined) parts.push(`dest=${host}${port !== undefined ? `:${port}` : ''}`)
  for (const [k, v] of Object.entries(rest)) {
    if (v === undefined || v === null) continue
    parts.push(`${k}=${typeof v === 'string' && !/^[\w.:@/*,-]+$/.test(v) ? JSON.stringify(v) : v}`)
  }
  return parts.join(' ')
}

/**
 * @param {string[]} argv
 * @param {{ stdout: { write(s: string): any }, stderr: { write(s: string): any }, startNode?: Function, dialer?: Function, process?: object, now?: number }} io
 *   `dialer(options)` returns `{ dial, dialUdp, resolve, exchange }` (default: `nodeDialer` on wsh's address guard); tests replace it.
 * @returns {Promise<number|null>}
 */
export async function main(argv, { stdout, stderr, startNode = startMeshNode, dialer, process: proc = process, now } = {}) {
  const say = (s) => stdout.write(`${s}\n`)
  const warn = (s) => stderr.write(`${s}\n`)
  let options
  try {
    const flags = parseArgv(argv)
    if (flags.help) { stdout.write(USAGE); return 0 }
    let config = {}
    if (flags.config) {
      let text
      try { text = await readFile(flags.config, 'utf8') } catch (e) { throw new UsageError(`Cannot read the config file ${flags.config}: ${e.code ?? e.message}.`) }
      let json
      try { json = JSON.parse(text) } catch { throw new UsageError(`The config file ${flags.config} is not valid JSON.`) }
      config = fromConfig(json)
    }
    options = resolveOptions(merge(config, flags), { now })
  } catch (e) {
    if (e instanceof UsageError) { warn(`browsermesh-egress: ${e.message}`); return 2 }
    throw e
  }
  for (const w of options.warnings) warn(`browsermesh-egress: ${w}`)

  // The network: wsh's address guard behind `dial`, `dialUdp`, `resolve`, and the fetch form's HTTP client.
  let network
  try {
    const make = dialer ?? (await import('../node.mjs')).nodeDialer
    network = make({ allowPrivate: options.allowPrivate, deny: options.deny })
  } catch (e) {
    warn(`browsermesh-egress: ${e?.message ?? e}`)
    return 2
  }
  const settings = {
    ...network,
    sets: options.sets,
    wide: options.wide ? { acknowledge: 'any-public-address' } : undefined,
    fetchMethods: options.fetchMethods,
    auditUrls: options.auditUrls,
    identifyConsumers: options.identifyConsumers,
    connectByResolvedAddress: options.connectByResolvedAddress,
    ...(options.keepAlive !== undefined ? { keepAlive: options.keepAlive } : {}),
    ...(options.blockedPorts ? { blockedPorts: options.blockedPorts } : {}),
    ...(options.blockedUdpPorts ? { blockedUdpPorts: options.blockedUdpPorts } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
    unattended: true,
  }
  // The same construction the running provider gets, against a stub: a bad limit or set is found by the dry run too.
  try {
    createMeshEgress({ ...settings, service: { serveProtocol() {} }, registry: { checkAccess: () => false } })
  } catch (e) {
    warn(`browsermesh-egress: ${e?.message ?? e}`)
    return 2
  }

  if (options.dryRun) {
    say('browsermesh-egress dry run: nothing is started, no key is read or written.')
    for (const line of describeGrants(options)) say(line)
    say(`fetch methods: ${options.fetchMethods.join(', ')}; audit of URLs: ${options.auditUrls}; consumers identified to destinations: ${options.identifyConsumers ? 'yes' : 'no'}`)
    say(`a connect to an address this provider's own lookup returned is taken for its name: ${options.connectByResolvedAddress ? 'yes (for a consumer that holds the name\'s dns and TCP grants)' : 'no'}; keep-alive: ${options.keepAlive === false ? 'off' : `every ${options.keepAlive?.intervalMs ?? 5000} ms`}`)
    say(`private space a named destination may resolve to: ${options.allowPrivate.length ? options.allowPrivate.join(', ') : 'none'}; always refused: ${options.deny.length ? options.deny.join(', ') : '(only the built-in classes)'}`)
    say(`wide mode: ${options.wide ? 'ON (any public address for a wildcard grant)' : 'off'}`)
    say('always refused: loopback, private, link-local, carrier-NAT, metadata and reserved addresses (unless the operator listed them above, for a named destination); ports 25, 465, 587 (TCP) and 53 (UDP)')
    return 0
  }

  let mesh
  try {
    mesh = await startNode({ signaling: options.signaling, identityPath: options.identity })
  } catch (e) {
    warn(`browsermesh-egress: cannot start the mesh node: ${e instanceof MeshStartError ? e.message : (e?.message ?? e)}`)
    return 1
  }

  const printAudit = (r) => say(options.json ? JSON.stringify(r) : formatAudit(r))
  let egress
  try {
    egress = createMeshEgress({ ...settings, service: mesh.service, registry: mesh.registry, onAudit: printAudit })
    for (const g of options.grants) mesh.registry.grantCapabilities(g.peer, [OPEN, ...g.scopes], g.expiresAt ? { expiresAt: g.expiresAt } : {})
    egress.start()
  } catch (e) {
    warn(`browsermesh-egress: ${e?.message ?? e}`)
    try { await egress?.stop() } catch { /* never started */ }
    await mesh.close()
    return 1
  }

  say(`browsermesh-egress pod id: ${mesh.podId}${mesh.created ? ' (new identity)' : ''}`)
  say(`serving ${options.grants.length} grant${options.grants.length === 1 ? '' : 's'} (run with --dry-run to read them as sentences); wide mode ${options.wide ? 'ON' : 'off'}; audit lines follow`)

  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    await egress.stop()
    await mesh.close()
    proc.exit?.(0)
  }
  proc.once?.('SIGINT', stop)
  proc.once?.('SIGTERM', stop)
  return null
}
