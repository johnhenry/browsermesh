/**
 * args.mjs -- the CLI's input: flags and an optional JSON config, merged and checked. Pure: no I/O, no process.
 *
 * Every refusal is a `UsageError` whose message is one sentence the person who typed the command can act on.
 */
import { checkHost, isPodId } from '../headers.mjs'
import { isLoopbackHost } from '../node.mjs'
import { parseBytes, parseDuration } from '../limits.mjs'

export class UsageError extends Error {
  constructor(message) { super(message); this.name = 'UsageError' }
}

export const USAGE = `browsermesh-ingress: serve a mesh pod over HTTP

Usage:
  browsermesh-ingress --signaling wss://signal.example --map app.example.test=<podId> [options]

Options:
  --listen HOST:PORT          where to listen (default 127.0.0.1:8080)
  --signaling URL             the signaling server the mesh node joins (wss://, or ws:// to loopback)
  --map HOST[/PREFIX]=PODID   serve this pod for this Host (repeatable); one pod per hostname
  --allow-methods LIST        methods served, comma separated (default GET,HEAD)
  --max-body SIZE             request body cap, e.g. 64k (default 64k)
  --timeout DURATION          whole-request deadline, e.g. 30s (default 30s)
  --auth bearer:FILE          require "Authorization: Bearer <the token in FILE>" on every request
  --identity FILE             the ingress's identity file (created on first run)
  --config FILE               a JSON file with the same options (flags win)
  --public                    allow a listen address that is not loopback ...
  --tls-terminated-in-front   ... and state that TLS is terminated in front of this listener
  --allow-shared-origin       allow different pods under path mappings of one hostname (not recommended)
  --help                      this text

The listener speaks plain HTTP. It binds to loopback unless you pass --public together with
--tls-terminated-in-front: there is no plaintext public default.

One origin per provider is your responsibility: two pods behind one hostname share cookies, storage and script
reach in a browser. Give each pod its own hostname.

Exit status: 0 after --help, 2 on bad input, 1 if the node cannot start.
`

const FLAGS = new Map([
  ['listen', 'value'], ['signaling', 'value'], ['map', 'list'], ['allow-methods', 'value'], ['max-body', 'value'], ['timeout', 'value'],
  ['auth', 'value'], ['identity', 'value'], ['config', 'value'], ['public', 'bool'], ['tls-terminated-in-front', 'bool'],
  ['allow-shared-origin', 'bool'], ['help', 'bool'],
])

/** @param {string[]} argv @returns {object} raw flags: `{ listen, map: [...], public: true, ... }` */
export function parseArgv(argv) {
  const out = { map: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h') { out.help = true; continue }
    if (!arg.startsWith('--')) throw new UsageError(`Unexpected argument "${arg}". Run with --help.`)
    const eq = arg.indexOf('=')
    const name = arg.slice(2, eq === -1 ? undefined : eq)
    const kind = FLAGS.get(name)
    if (!kind) throw new UsageError(`Unknown option --${name}. Run with --help.`)
    if (kind === 'bool') {
      if (eq !== -1) throw new UsageError(`--${name} takes no value.`)
      out[name] = true
      continue
    }
    const value = eq !== -1 ? arg.slice(eq + 1) : argv[++i]
    if (value === undefined || (eq === -1 && value.startsWith('--'))) throw new UsageError(`--${name} needs a value.`)
    if (kind === 'list') out[name].push(value)
    else {
      if (name in out) throw new UsageError(`--${name} was given twice.`)
      out[name] = value
    }
  }
  return out
}

/** A config file's contents -> the same shape `parseArgv` makes. Unknown keys are refused: a typo must not be silently ignored. */
export function fromConfig(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new UsageError('The config file must contain one JSON object.')
  const out = { map: [] }
  const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
  const byCamel = new Map([...FLAGS.keys()].map((n) => [camel(n), n]))
  for (const [key, value] of Object.entries(json)) {
    const name = FLAGS.has(key) ? key : byCamel.get(key)
    if (!name || name === 'config' || name === 'help') throw new UsageError(`The config file has an unknown key "${key}".`)
    const kind = FLAGS.get(name)
    if (name === 'map') {
      if (Array.isArray(value)) out.map.push(...value.map(String))
      else if (value && typeof value === 'object') for (const [host, pod] of Object.entries(value)) out.map.push(`${host}=${pod}`)
      else throw new UsageError('"map" in the config file must be an object of host: podId, or a list of host=podId.')
    } else if (kind === 'bool') out[name] = value === true
    else out[name] = Array.isArray(value) ? value.join(',') : String(value)
  }
  return out
}

/** Flags win over the config file; `map` entries of both are kept. */
export function merge(config, flags) {
  const out = { ...config, ...flags, map: [...(config.map ?? []), ...(flags.map ?? [])] }
  return out
}

/** @returns {{ host: string, prefix: string, peer: string }} */
export function parseMapping(text) {
  const eq = text.lastIndexOf('=')
  if (eq <= 0 || eq === text.length - 1) throw new UsageError(`--map "${text}" is not HOST=PODID (or HOST/PREFIX=PODID).`)
  const left = text.slice(0, eq)
  const peer = text.slice(eq + 1)
  if (!isPodId(peer)) throw new UsageError(`--map "${text}": "${peer}" is not a pod id.`)
  const slash = left.indexOf('/')
  const hostPart = slash === -1 ? left : left.slice(0, slash)
  let prefix = slash === -1 ? '' : left.slice(slash)
  let host
  try { host = checkHost(hostPart) } catch { throw new UsageError(`--map "${text}": "${hostPart}" is not a hostname (with an optional port).`) }
  if (prefix) {
    prefix = prefix.replace(/\/+$/, '')
    if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(prefix) || prefix.includes('//') || prefix.split('/').some((s) => s === '.' || s === '..')) {
      throw new UsageError(`--map "${text}": "${left.slice(slash)}" is not a plain path prefix.`)
    }
  }
  return { host, prefix, peer }
}

/**
 * The checked configuration. `warnings` are sentences for stderr; nothing is read from disk here.
 * @returns {{ host: string, port: number, signaling: string, mappings: object[], methods: string[], maxBody: number|undefined,
 *   timeoutMs: number|undefined, auth: { file: string }|null, identity: string|undefined, public: boolean, warnings: string[] }}
 */
export function resolveOptions(raw) {
  const warnings = []
  const listen = raw.listen ?? '127.0.0.1:8080'
  const m = /^(?:\[([0-9a-fA-F:.]+)\]|([^:\s]+)):(\d{1,5})$/.exec(listen)
  if (!m) throw new UsageError(`--listen "${listen}" is not HOST:PORT (for IPv6, [::1]:PORT).`)
  const host = m[1] ?? m[2]
  const port = Number(m[3])
  if (port > 65535) throw new UsageError(`--listen "${listen}": the port is out of range.`)
  const isPublic = !isLoopbackHost(host)
  if (isPublic && !raw.public) throw new UsageError(`--listen ${host} is not a loopback address. Serving on a public address needs --public together with --tls-terminated-in-front: this listener speaks plain HTTP, so TLS must be terminated in front of it.`)
  if (isPublic && !raw['tls-terminated-in-front']) throw new UsageError('--public needs --tls-terminated-in-front: state that TLS is terminated in front of this listener. There is no plaintext public default.')
  if (!isPublic && raw.public) warnings.push('--public has no effect on a loopback listen address.')

  if (!raw.signaling) throw new UsageError('--signaling URL is required: the mesh node needs a signaling server to find pods.')
  let sig
  try { sig = new URL(raw.signaling) } catch { throw new UsageError(`--signaling "${raw.signaling}" is not a URL.`) }
  if (sig.protocol !== 'wss:' && !(sig.protocol === 'ws:' && isLoopbackHost(sig.hostname))) throw new UsageError('--signaling must be wss:// (ws:// is accepted only for a loopback server).')

  if (!raw.map.length) throw new UsageError('At least one --map HOST=PODID is required: nothing is served without a mapping.')
  const mappings = raw.map.map(parseMapping)
  const seen = new Map() // host -> mappings
  for (const mp of mappings) {
    const list = seen.get(mp.host) ?? []
    if (list.some((o) => o.prefix === mp.prefix)) throw new UsageError(`${mp.host}${mp.prefix} is mapped twice.`)
    list.push(mp)
    seen.set(mp.host, list)
  }
  for (const [hostName, list] of seen) {
    const pods = new Set(list.map((o) => o.peer))
    if (pods.size > 1 && !raw['allow-shared-origin']) {
      throw new UsageError(`${hostName} is mapped to ${pods.size} different pods. One origin per provider: give each pod its own hostname (or pass --allow-shared-origin and accept that those pods can read each other's cookies and storage).`)
    }
    if (list.some((o) => o.prefix)) warnings.push(`warning: ${hostName} is served from more than one path mapping, so those mappings share one origin. One origin per provider is your responsibility.`)
  }

  const methods = (raw['allow-methods'] ?? 'GET,HEAD').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
  const known = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
  if (!methods.length || methods.some((x) => !known.includes(x))) throw new UsageError(`--allow-methods must be a list of ${known.join(', ')}.`)

  let maxBody, timeoutMs
  try { if (raw['max-body'] !== undefined) maxBody = parseBytes(raw['max-body']) } catch { throw new UsageError(`--max-body "${raw['max-body']}" is not a size (for example 64k).`) }
  try { if (raw.timeout !== undefined) timeoutMs = parseDuration(raw.timeout) } catch { throw new UsageError(`--timeout "${raw.timeout}" is not a duration (for example 30s).`) }

  let auth = null
  if (raw.auth !== undefined) {
    const am = /^bearer:(.+)$/.exec(raw.auth)
    if (!am) throw new UsageError('--auth must be bearer:FILE, where FILE holds the token.')
    auth = { file: am[1] }
  }
  return { host, port, signaling: raw.signaling, mappings, methods, maxBody, timeoutMs, auth, identity: raw.identity, public: isPublic, warnings }
}

/**
 * Hostname (+ prefix) -> pod, longest prefix first. A request whose Host is not mapped gets no mapping (404).
 * With a prefix the provider is asked for the rest of the path.
 */
export function createResolver(mappings) {
  const byHost = new Map()
  for (const mp of mappings) { const l = byHost.get(mp.host) ?? []; l.push(mp); byHost.set(mp.host, l) }
  for (const l of byHost.values()) l.sort((a, b) => b.prefix.length - a.prefix.length)
  return (request) => {
    const url = new URL(request.url)
    const list = byHost.get(url.host)
    if (!list) return null
    for (const mp of list) {
      if (!mp.prefix) return { peer: mp.peer }
      if (url.pathname === mp.prefix || url.pathname.startsWith(`${mp.prefix}/`)) return { peer: mp.peer, path: url.pathname.slice(mp.prefix.length) || '/' }
    }
    return null
  }
}
