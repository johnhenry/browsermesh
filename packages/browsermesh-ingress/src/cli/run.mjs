/**
 * run.mjs -- `browsermesh-ingress`: parse, check, start the mesh node, start the listener, say what it serves.
 *
 * `main` returns an exit code when the process should end (`--help`, bad input, a node that cannot start) and
 * `null` once the listener is up, so the open server keeps the process alive.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createMeshIngress } from '../ingress.mjs'
import { applyForcedHeaders } from '../headers.mjs'
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
  const ingress = createMeshIngress({
    service: mesh.service,
    resolve: createResolver(options.mappings),
    methods: options.methods,
    limits,
    deny: token ? bearerDeny(token) : undefined,
    onAudit: (r) => say(`${r.method} ${r.host} -> ${r.peer ?? '-'} ${r.status}${r.reason ? ` (${r.reason})` : ''} in ${r.requestBytes}B out ${r.responseBytes}B ${r.durationMs}ms`),
  })
  let listener
  try {
    listener = await listenNode(ingress, { host: options.host, port: options.port, public: options.public, trustProxy: false })
  } catch (e) {
    await ingress.close()
    await mesh.close()
    warn(`browsermesh-ingress: cannot listen on ${options.host}:${options.port}: ${e?.code ?? e?.message}`)
    return 1
  }

  say(`browsermesh-ingress pod id: ${mesh.podId}${mesh.created ? ' (new identity)' : ''}`)
  for (const mp of options.mappings) say(`serving ${mp.host}${mp.prefix} -> ${mp.peer}`)
  say(`methods: ${options.methods.join(', ')}; body cap ${limits.maxRequestBodyBytes ?? 65536} bytes; auth: ${token ? 'bearer token required' : 'none'}`)
  say(`listening on http://${options.host.includes(':') ? `[${options.host}]` : options.host}:${listener.port}`)

  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    await listener.close()
    await ingress.close()
    await mesh.close()
    proc.exit?.(0)
  }
  proc.once?.('SIGINT', stop)
  proc.once?.('SIGTERM', stop)
  return null
}
