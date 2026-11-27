/**
 * args.mjs -- the CLI's input: flags and an optional JSON config, merged and checked. Pure: no I/O, no process.
 *
 * Every refusal is a `UsageError` whose message is one sentence the person who typed the command can act on.
 */
import { checkHost, hostName, isPodId } from '../headers.mjs'
import { isLoopbackHost } from '../node.mjs'
import { parseBytes, parseDuration } from '../limits.mjs'
import { NAME_DENY_DEFAULTS, NameRefusal, checkLabel } from '../names.mjs'
import { SERVICE_NAME_RE, parseMethodPolicy } from '../wire.mjs'

const ZONE_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const PATH_RE = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/

export class UsageError extends Error {
  constructor(message) { super(message); this.name = 'UsageError' }
}

export const USAGE = `browsermesh-ingress: serve a mesh pod over HTTP

Usage:
  browsermesh-ingress --signaling wss://signal.example --map app.example.test=<podId> [options]

Options:
  (A value is the next argument whatever it starts with, so a pod id that begins with -- works; the one exception is a
   next argument that is itself a known option, which means the value is missing. --option=value is safe for any value.)
  --listen HOST:PORT          where to listen (default 127.0.0.1:8080)
  --signaling URL             the signaling server the mesh node joins (wss://, or ws:// to loopback)
  --map HOST[/PREFIX]=PODID[#SERVICE]
                              serve this pod for this Host (repeatable); one pod per hostname. #SERVICE names
                              the service on that pod (the pod declares which it serves), so one pod can serve
                              several ports or sites under different hostnames or paths
  --link-wait DURATION        how long a request waits for a mapped pod's link that is still being made
                              (default 5s; 0 turns the wait and the dialling at start off)
  --ready-path PATH           answer GET PATH with 200 once every mapped pod is linked, 503 before (off by default)
  --names-zone ZONE           let pods claim names under ZONE (a claim for app is app.ZONE) ... (off by default)
  --names-allow PODID=LABELS  ... this pod may claim these names (comma separated; * is any); repeatable and required
  --names-deny LABELS         names refused on top of the built-in deny-list (www, api, admin ...); a trailing * is a prefix
  --names-max N               names held at once in the zone (default 64)
  --names-max-per-pod N       names one pod may hold (default 4)
  --names-hold DURATION       how long a name stays its pod's after its link drops (default 30s; 0 frees it at once)
  --allow-methods LIST        methods carried: * (every method, the default) or a comma separated list to narrow it, e.g. GET,HEAD.
                              CONNECT, TRACE and TRACK are never carried. A pod that has not upgraded is sent GET and HEAD only
  --max-body SIZE             request body cap, streamed (default 32m; "unlimited" lifts it)
  --max-uploads N             requests with a body in flight to one pod at a time (default 4)
  --timeout DURATION          whole-request deadline, e.g. 30s (default 30s)
  --upload-timeout DURATION   whole-request deadline for a request with a body (default 5m)
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
  ['upload-timeout', 'value'], ['max-uploads', 'value'],
  ['auth', 'value'], ['identity', 'value'], ['config', 'value'], ['public', 'bool'], ['tls-terminated-in-front', 'bool'],
  ['allow-shared-origin', 'bool'], ['help', 'bool'],
  ['link-wait', 'value'], ['ready-path', 'value'],
  ['names-zone', 'value'], ['names-allow', 'list'], ['names-deny', 'value'], ['names-max', 'value'], ['names-max-per-pod', 'value'], ['names-hold', 'value'],
])

/** True when `token` is `-h`, or `--NAME` / `--NAME=...` for an option this CLI knows: it can never be a value. */
function isKnownOption(token) {
  if (token === '-h') return true
  if (!token.startsWith('--')) return false
  const eq = token.indexOf('=')
  return FLAGS.has(token.slice(2, eq === -1 ? undefined : eq))
}

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
    // The `--name=value` form takes everything after the first `=`. In the separate form the next argument is the value
    // whatever it starts with (a pod id may begin with `--`), unless it is the end of the arguments or is itself a known
    // option (`--known`, `--known=...`, `-h`): then the value is missing.
    if (eq === -1 && (i + 1 >= argv.length || isKnownOption(argv[i + 1]))) throw new UsageError(`--${name} needs a value.`)
    const value = eq !== -1 ? arg.slice(eq + 1) : argv[++i]
    if (kind === 'list') (out[name] ??= []).push(value)
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
    } else if (name === 'names-allow') {
      const list = (out['names-allow'] ??= [])
      if (Array.isArray(value)) list.push(...value.map(String))
      else if (value && typeof value === 'object') for (const [pod, labels] of Object.entries(value)) list.push(`${pod}=${Array.isArray(labels) ? labels.join(',') : labels}`)
      else throw new UsageError('"namesAllow" in the config file must be an object of podId: labels, or a list of podId=labels.')
    } else if (kind === 'bool') out[name] = value === true
    else out[name] = Array.isArray(value) ? value.join(',') : String(value)
  }
  return out
}

/** Flags win over the config file; `map` and `names-allow` entries of both are kept. */
export function merge(config, flags) {
  const out = { ...config, ...flags, map: [...(config.map ?? []), ...(flags.map ?? [])] }
  const allow = [...(config['names-allow'] ?? []), ...(flags['names-allow'] ?? [])]
  if (allow.length) out['names-allow'] = allow
  return out
}

/** @returns {{ host: string, prefix: string, peer: string, service?: string }} */
export function parseMapping(text) {
  const eq = text.lastIndexOf('=')
  if (eq <= 0 || eq === text.length - 1) throw new UsageError(`--map "${text}" is not HOST=PODID (or HOST/PREFIX=PODID[#SERVICE]).`)
  const left = text.slice(0, eq)
  let peer = text.slice(eq + 1)
  let service
  const hash = peer.indexOf('#')
  if (hash !== -1) {
    service = peer.slice(hash + 1)
    peer = peer.slice(0, hash)
    if (!SERVICE_NAME_RE.test(service)) throw new UsageError(`--map "${text}": "${service}" is not a service name (lowercase letters, digits, . _ -, up to 64).`)
  }
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
  return { host, prefix, peer, ...(service === undefined ? {} : { service }) }
}

const ALLOW_HELP = 'is not PODID=LABELS (comma separated labels, or *)'

/** The names options, or null when `--names-zone` is not given. Every flag of the family without it is refused. */
function resolveNames(raw) {
  const given = ['names-allow', 'names-deny', 'names-max', 'names-max-per-pod', 'names-hold'].filter((k) => (Array.isArray(raw[k]) ? raw[k].length : raw[k] !== undefined))
  if (raw['names-zone'] === undefined) {
    if (given.length) throw new UsageError(`--${given[0]} needs --names-zone: names are off unless a zone is given.`)
    return null
  }
  const zone = String(raw['names-zone'])
  if (!ZONE_RE.test(zone)) throw new UsageError(`--names-zone "${zone}" is not a lowercase hostname without a port.`)
  if (!raw['names-allow']?.length) throw new UsageError('--names-zone needs at least one --names-allow PODID=LABELS: nothing is claimable without a grant.')
  const denied = new Set(NAME_DENY_DEFAULTS)
  const allow = raw['names-allow'].map((text) => {
    const eq = text.indexOf('=')
    const pod = eq === -1 ? '' : text.slice(0, eq)
    const labels = eq === -1 ? [] : text.slice(eq + 1).split(',').map((s) => s.trim()).filter(Boolean)
    if (!isPodId(pod) || !labels.length) throw new UsageError(`--names-allow "${text}" ${ALLOW_HELP}.`)
    for (const l of labels) {
      if (l === '*') continue
      try { checkLabel(l) } catch (e) { if (e instanceof NameRefusal) throw new UsageError(`--names-allow "${text}": "${l}" is not a name (a lowercase DNS label).`); throw e }
      if (denied.has(l)) throw new UsageError(`--names-allow "${text}": "${l}" is on the deny-list and is never claimable; map it with --map instead.`)
    }
    return { pod, labels }
  })
  const deny = raw['names-deny'] === undefined ? [] : String(raw['names-deny']).split(',').map((s) => s.trim()).filter(Boolean)
  for (const d of deny) if (!/^[a-z0-9][a-z0-9-]*\*?$/.test(d)) throw new UsageError(`--names-deny "${d}" is not a label (a trailing * is a prefix).`)
  const count = (flag) => {
    if (raw[flag] === undefined) return undefined
    if (!/^\d{1,6}$/.test(String(raw[flag])) || Number(raw[flag]) < 1) throw new UsageError(`--${flag} "${raw[flag]}" is not a positive number.`)
    return Number(raw[flag])
  }
  let holdMs
  if (raw['names-hold'] !== undefined) {
    if (/^0(?:ms|s|m)?$/.test(String(raw['names-hold']).trim())) holdMs = 0
    else try { holdMs = parseDuration(raw['names-hold']) } catch { throw new UsageError(`--names-hold "${raw['names-hold']}" is not a duration (for example 30s, or 0).`) }
  }
  return { zone, allow, deny, maxNames: count('names-max'), maxPerPod: count('names-max-per-pod'), holdMs }
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

  const names = resolveNames(raw)
  if (!raw.map.length && !names) throw new UsageError('At least one --map HOST=PODID is required: nothing is served without a mapping (or --names-zone, to let pods claim names).')
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

  // Every method by default (`*`); a list narrows it. Standard methods are upper-cased (`get` is GET); an extension method is a token, kept as written.
  let methods = '*'
  if (raw['allow-methods'] !== undefined) {
    const text = String(raw['allow-methods']).trim()
    if (text !== '*') {
      const list = text.split(',').map((s) => s.trim()).filter(Boolean)
      try { methods = parseMethodPolicy(list.length ? list : null, '--allow-methods').list } catch { throw new UsageError('--allow-methods must be * or a comma separated list of method names (an RFC 9110 token; CONNECT, TRACE and TRACK are never served).') }
    }
  }

  let maxBody, timeoutMs, uploadTimeoutMs, maxUploads
  try { if (raw['max-body'] !== undefined) maxBody = /^unlimited$/i.test(String(raw['max-body']).trim()) ? Infinity : parseBytes(raw['max-body']) } catch { throw new UsageError(`--max-body "${raw['max-body']}" is not a size (for example 64k, or "unlimited").`) }
  try { if (raw.timeout !== undefined) timeoutMs = parseDuration(raw.timeout) } catch { throw new UsageError(`--timeout "${raw.timeout}" is not a duration (for example 30s).`) }
  try { if (raw['upload-timeout'] !== undefined) uploadTimeoutMs = parseDuration(raw['upload-timeout']) } catch { throw new UsageError(`--upload-timeout "${raw['upload-timeout']}" is not a duration (for example 5m).`) }
  if (raw['max-uploads'] !== undefined) {
    if (!/^\d{1,4}$/.test(String(raw['max-uploads'])) || Number(raw['max-uploads']) < 1) throw new UsageError(`--max-uploads "${raw['max-uploads']}" is not a positive number.`)
    maxUploads = Number(raw['max-uploads'])
  }

  let auth = null
  if (raw.auth !== undefined) {
    const am = /^bearer:(.+)$/.exec(raw.auth)
    if (!am) throw new UsageError('--auth must be bearer:FILE, where FILE holds the token.')
    auth = { file: am[1] }
  }
  let linkWaitMs
  if (raw['link-wait'] !== undefined) {
    if (/^0(?:ms|s|m)?$/.test(String(raw['link-wait']).trim())) linkWaitMs = 0
    else try { linkWaitMs = parseDuration(raw['link-wait']) } catch { throw new UsageError(`--link-wait "${raw['link-wait']}" is not a duration (for example 5s, or 0).`) }
  }
  let readyPath
  if (raw['ready-path'] !== undefined) {
    readyPath = String(raw['ready-path'])
    if (!PATH_RE.test(readyPath) || readyPath.startsWith('//')) throw new UsageError(`--ready-path "${readyPath}" is not a plain absolute path (for example /_ready).`)
  }
  if (names && mappings.some((mp) => hostName(mp.host).endsWith(`.${names.zone}`))) {
    warnings.push(`warning: a --map host is under the names zone ${names.zone}; pods cannot claim that name (the mapping wins).`)
  }
  return { host, port, signaling: raw.signaling, mappings, methods, maxBody, timeoutMs, uploadTimeoutMs, maxUploads, auth, identity: raw.identity, public: isPublic, warnings, names, linkWaitMs, readyPath }
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
    const svc = (mp) => (mp.service === undefined ? {} : { service: mp.service })
    for (const mp of list) {
      if (!mp.prefix) return { peer: mp.peer, ...svc(mp) }
      if (url.pathname === mp.prefix || url.pathname.startsWith(`${mp.prefix}/`)) return { peer: mp.peer, path: url.pathname.slice(mp.prefix.length) || '/', ...svc(mp) }
    }
    return null
  }
}
