/**
 * args.mjs -- the CLI's input: flags and a JSON config file, merged and checked. Pure: no I/O, no process.
 *
 * Every refusal is a `UsageError` whose message is one sentence the person who typed the command can act on. A typo never
 * widens anything: an unknown flag, an unknown config key and a scope this package does not know are refused, not ignored.
 */
import { checkHost, checkName, checkPort, compileSets, looksLikePodId } from '../destination.mjs'
import { KNOWN_METHODS } from '../http-policy.mjs'
import { EGRESS_LIMIT_DEFAULTS } from '../limits.mjs'
import { WIDE_ACKNOWLEDGEMENT } from '../provider.mjs'

export class UsageError extends Error {
  constructor(message) { super(message); this.name = 'UsageError' }
}

export const USAGE = `browsermesh-egress: lend this machine's network to mesh peers that hold a grant

Usage:
  browsermesh-egress --config grants.json --signaling wss://signal.example [options]
  browsermesh-egress --config grants.json --dry-run

Options:
  --config FILE               a JSON file: { "grants": [{ "peer": "<podId>", "scopes": [...], "expiresAt": "<ISO time>" }], "sets": {...}, ... }
  --allow PODID=SCOPE[,SCOPE] one more grant (repeatable); the protocol scope is added for you
  --set NAME=ENTRY[,ENTRY]    an operator-named destination set, entries as host:ports (repeatable)
  --signaling URL             the signaling server the mesh node joins (wss://, or ws:// to loopback)
  --identity FILE             this provider's identity file (created on first run, mode 0600)
  --allow-private CIDR        private space a destination a grant names may resolve to (repeatable; default none)
  --deny CIDR                 addresses always refused (repeatable)
  --fetch-methods LIST        methods the fetch form serves, comma separated (default GET,HEAD)
  --audit-urls MODE           what the audit says of a URL: none (path length only, the default), path, full (path and query)
  --identify-consumers        tell destinations which pod asked (an x-browsermesh-consumer header on fetches)
  --wide                      let a holder of a wildcard grant reach ANY public address; needs the next flag
  --acknowledge-wide VALUE    must be exactly "${WIDE_ACKNOWLEDGEMENT}"
  --json                      print each audit record as one JSON line
  --dry-run                   print what would be allowed and exit; nothing is started, no key is read or written
  --help                      this text

Scopes (what a grant says):
  egress:tcp:HOST:PORT:connect     TCP to that host and port (PORT may be *: any port of that host)
  egress:http:HOST:PORT:fetch      the FETCH FORM: this provider makes the HTTP(S) request and sees it in plaintext
  egress:udp:HOST:PORT:send        UDP datagrams to that host and port
  egress:dns:NAME:resolve          look up that name
  egress:set:NAME:connect|fetch|send   the same, for anything the set NAME lists
  A * in the HOST place is a wildcard grant: refused unless --wide and --acknowledge-wide are given.

Private, loopback, link-local and metadata addresses stay refused, wide mode included. Mail ports (25, 465, 587) and UDP
port 53 stay blocked. The audit lines never carry a payload, a header or (by default) a path.

Exit status: 0 after --help or --dry-run, 2 on bad input, 1 if the node cannot start.
`

const FLAGS = new Map([
  ['config', 'value'], ['allow', 'list'], ['set', 'list'], ['signaling', 'value'], ['identity', 'value'], ['allow-private', 'list'], ['deny', 'list'],
  ['fetch-methods', 'value'], ['audit-urls', 'value'], ['identify-consumers', 'bool'], ['wide', 'bool'], ['acknowledge-wide', 'value'],
  ['json', 'bool'], ['dry-run', 'bool'], ['help', 'bool'],
])
/** Keys only the config file has (structured values). */
const CONFIG_ONLY = new Set(['grants', 'limits', 'blockedPorts', 'blockedUdpPorts'])

/** @param {string[]} argv @returns {object} raw flags, lists as arrays */
export function parseArgv(argv) {
  const out = {}
  for (const [name, kind] of FLAGS) if (kind === 'list') out[name] = []
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

const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())

/** A config file's contents -> the same shape `parseArgv` makes, plus the structured keys. Unknown keys are refused. */
export function fromConfig(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new UsageError('The config file must contain one JSON object.')
  const out = {}
  for (const [name, kind] of FLAGS) if (kind === 'list') out[name] = []
  const byCamel = new Map([...FLAGS.keys()].map((n) => [camel(n), n]))
  for (const [key, value] of Object.entries(json)) {
    if (CONFIG_ONLY.has(key)) { out[key] = value; continue }
    const name = key === 'sets' ? 'set' : FLAGS.has(key) ? key : byCamel.get(key)
    if (key === 'wide' || key === 'acknowledgeWide' || key === 'acknowledge-wide') throw new UsageError('Wide mode is not a config file setting: it is the flags --wide --acknowledge-wide, so that it is said at the command line every time.')
    if (!name || name === 'config' || name === 'help' || name === 'dry-run') throw new UsageError(`The config file has an unknown key "${key}".`)
    const kind = FLAGS.get(name)
    if (name === 'set') {
      if (value && typeof value === 'object' && !Array.isArray(value)) for (const [n, entries] of Object.entries(value)) out.set.push(`${n}=${[].concat(entries).join(',')}`)
      else throw new UsageError('"sets" in the config file is an object of name: [entries].')
    } else if (kind === 'list') out[name].push(...[].concat(value).map(String))
    else if (kind === 'bool') out[name] = value === true
    else out[name] = Array.isArray(value) ? value.join(',') : String(value)
  }
  return out
}

/** Flags win over the config file; lists of both are kept. */
export function merge(config, flags) {
  const out = { ...config }
  for (const [k, v] of Object.entries(flags)) {
    if (Array.isArray(v)) out[k] = [...(config[k] ?? []), ...v]
    else out[k] = v
  }
  for (const k of ['grants']) if (config[k] !== undefined) out[k] = config[k]
  return out
}

/**
 * One scope, parsed. Only the exact forms of this package are accepted: a broad wildcard (`egress:*`, `*`) is not written
 * in a CLI grant, so a typo cannot widen anything.
 * @returns {{ scope: string, family: string, host: string|null, port: number|'*'|null, action: string, wide: boolean, set: string|null }}
 */
export function parseScope(scope) {
  const bad = (why) => new UsageError(`"${scope}" is not a scope of this provider (${why}). Run with --help for the forms.`)
  if (typeof scope !== 'string') throw bad('not a string')
  let m = /^egress:(tcp|http|udp):([^:]+):(\d{1,5}|\*):(connect|fetch|send)$/.exec(scope)
  if (m) {
    const [, family, host, port, action] = m
    if ((family === 'tcp') !== (action === 'connect') || (family === 'http') !== (action === 'fetch') || (family === 'udp') !== (action === 'send')) throw bad(`${family} goes with ${{ tcp: 'connect', http: 'fetch', udp: 'send' }[family]}`)
    if (host !== '*') { try { checkHost(host) } catch { throw bad('the host is not a lowercase DNS name or a dotted IPv4 address') } }
    if (port !== '*') { try { checkPort(Number(port)) } catch { throw bad('the port is not 1 to 65535') } }
    return { scope, family, host: host === '*' ? null : host, port: port === '*' ? '*' : Number(port), action, wide: host === '*', set: null }
  }
  m = /^egress:dns:([^:]+):resolve$/.exec(scope)
  if (m) {
    if (m[1] !== '*') { try { checkName(m[1]) } catch { throw bad('the name is not a lowercase DNS name') } }
    return { scope, family: 'dns', host: m[1] === '*' ? null : m[1], port: null, action: 'resolve', wide: m[1] === '*', set: null }
  }
  m = /^egress:set:([a-z0-9][a-z0-9._-]{0,63}):(connect|fetch|send)$/.exec(scope)
  if (m) return { scope, family: 'set', host: null, port: null, action: m[2], wide: false, set: m[1] }
  throw bad('unknown form')
}

/** `2026-12-01T00:00:00Z` or a number of milliseconds since the epoch, in the future. */
function parseExpiry(value, where, nowMs) {
  const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
  if (!Number.isFinite(ms)) throw new UsageError(`${where}: expiresAt is an ISO time or milliseconds since the epoch.`)
  if (ms <= nowMs) throw new UsageError(`${where}: expiresAt is in the past.`)
  return ms
}

function parseGrantFlag(text) {
  const eq = text.indexOf('=')
  if (eq <= 0 || eq === text.length - 1) throw new UsageError(`--allow "${text}" is not PODID=SCOPE[,SCOPE].`)
  return { peer: text.slice(0, eq), scopes: text.slice(eq + 1).split(',').map((s) => s.trim()).filter(Boolean) }
}

/**
 * The checked configuration. Nothing is read from disk here.
 * @returns {{ signaling: string|undefined, identity: string|undefined, grants: Array<{ peer: string, scopes: string[], parsed: object[], expiresAt: number|null }>,
 *   sets: Record<string, string[]>, allowPrivate: string[], deny: string[], fetchMethods: string[], auditUrls: string, identifyConsumers: boolean,
 *   wide: boolean, blockedPorts: number[]|undefined, blockedUdpPorts: number[]|undefined, limits: object|undefined, json: boolean, dryRun: boolean, warnings: string[] }}
 */
export function resolveOptions(raw, { now = Date.now() } = {}) {
  const warnings = []
  let signaling
  if (raw.signaling !== undefined) {
    let sig
    try { sig = new URL(raw.signaling) } catch { throw new UsageError(`--signaling "${raw.signaling}" is not a URL.`) }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(sig.hostname)
    if (sig.protocol !== 'wss:' && !(sig.protocol === 'ws:' && loopback)) throw new UsageError('--signaling must be wss:// (ws:// is accepted only for a loopback server).')
    signaling = raw.signaling
  } else if (!raw['dry-run']) throw new UsageError('--signaling URL is required: the mesh node needs a signaling server for peers to find it.')

  const grants = []
  const given = [...(Array.isArray(raw.grants) ? raw.grants : raw.grants === undefined ? [] : (() => { throw new UsageError('"grants" in the config file is a list of { peer, scopes, expiresAt? }.') })()),
    ...raw.allow.map(parseGrantFlag)]
  for (const [i, g] of given.entries()) {
    const where = `grant ${i + 1}`
    if (!g || typeof g !== 'object' || Array.isArray(g)) throw new UsageError(`${where} is not an object.`)
    for (const key of Object.keys(g)) if (!['peer', 'scopes', 'expiresAt'].includes(key)) throw new UsageError(`${where} has an unknown key "${key}".`)
    if (!looksLikePodId(g.peer)) throw new UsageError(`${where}: "${g.peer}" is not a pod id.`)
    if (!Array.isArray(g.scopes) || !g.scopes.length) throw new UsageError(`${where}: scopes is a non-empty list.`)
    const parsed = g.scopes.map(parseScope)
    grants.push({ peer: g.peer, scopes: [...new Set(g.scopes)], parsed, expiresAt: g.expiresAt === undefined ? null : parseExpiry(g.expiresAt, where, now) })
  }
  if (!grants.length) throw new UsageError('At least one grant is required: nothing is lent without one. Use a "grants" list in --config, or --allow PODID=SCOPE.')

  const sets = {}
  for (const text of raw.set) {
    const eq = text.indexOf('=')
    if (eq <= 0 || eq === text.length - 1) throw new UsageError(`--set "${text}" is not NAME=ENTRY[,ENTRY].`)
    const name = text.slice(0, eq)
    sets[name] = [...(sets[name] ?? []), ...text.slice(eq + 1).split(',').map((s) => s.trim()).filter(Boolean)]
  }
  // Entries are `host:ports` and ports may hold commas (`a.test:80,443`): re-join a piece that is only ports onto the entry before it.
  for (const [name, pieces] of Object.entries(sets)) {
    const entries = []
    for (const p of pieces) { if (/^[\d*,-]+$/.test(p) && entries.length) entries[entries.length - 1] += `,${p}`; else entries.push(p) }
    sets[name] = entries
  }
  try { compileSets(sets) } catch (e) { throw new UsageError(`Destination sets: ${e.message}`) }
  for (const g of grants) for (const p of g.parsed) if (p.set && !Object.hasOwn(sets, p.set)) throw new UsageError(`${p.scope}: there is no set named "${p.set}" (--set ${p.set}=host:ports).`)

  const fetchMethods = (raw['fetch-methods'] ?? 'GET,HEAD').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
  if (!fetchMethods.length || fetchMethods.some((m) => !KNOWN_METHODS.includes(m))) throw new UsageError(`--fetch-methods is a list of ${KNOWN_METHODS.join(', ')}.`)
  const auditUrls = raw['audit-urls'] ?? 'none'
  if (!['none', 'path', 'full'].includes(auditUrls)) throw new UsageError('--audit-urls is none, path or full.')

  const wildcards = grants.flatMap((g) => g.parsed.filter((p) => p.wide).map((p) => p.scope))
  const wide = raw.wide === true
  if (raw['acknowledge-wide'] !== undefined && !wide) throw new UsageError('--acknowledge-wide has no effect without --wide.')
  if (wide) {
    if (raw['acknowledge-wide'] !== WIDE_ACKNOWLEDGEMENT) throw new UsageError(`--wide lets a holder of a wildcard grant reach any public address from this machine. Say you mean it with --acknowledge-wide ${WIDE_ACKNOWLEDGEMENT}.`)
    if (!wildcards.length) warnings.push('--wide is on but no grant is a wildcard grant: it has no effect.')
  } else if (wildcards.length) {
    throw new UsageError(`${wildcards.join(', ')} ${wildcards.length > 1 ? 'are wildcard grants' : 'is a wildcard grant'}: it lets its holder reach any public address. Refused without --wide --acknowledge-wide ${WIDE_ACKNOWLEDGEMENT}.`)
  }

  const portList = (v, name) => {
    if (v === undefined) return undefined
    if (!Array.isArray(v) || !v.every((p) => Number.isSafeInteger(p) && p >= 1 && p <= 65535)) throw new UsageError(`"${name}" in the config file is a list of ports.`)
    return v
  }
  let limits
  if (raw.limits !== undefined) {
    if (!raw.limits || typeof raw.limits !== 'object' || Array.isArray(raw.limits)) throw new UsageError('"limits" in the config file is an object.')
    for (const k of Object.keys(raw.limits)) if (!Object.hasOwn(EGRESS_LIMIT_DEFAULTS, k)) throw new UsageError(`"limits.${k}" is not a limit.`)
    limits = raw.limits
  }
  return {
    signaling, identity: raw.identity, grants, sets, allowPrivate: raw['allow-private'], deny: raw.deny, fetchMethods, auditUrls,
    identifyConsumers: raw['identify-consumers'] === true, wide, blockedPorts: portList(raw.blockedPorts, 'blockedPorts'), blockedUdpPorts: portList(raw.blockedUdpPorts, 'blockedUdpPorts'),
    limits, json: raw.json === true, dryRun: raw['dry-run'] === true, warnings,
  }
}

const WHAT = {
  tcp: (where) => `open TCP connections to ${where} (TLS stays between the peer and the destination: this provider relays bytes it cannot read)`,
  http: (where) => `fetch http(s) URLs on ${where}. THIS PROVIDER makes the request: it sees the URL, headers, bodies and responses in plaintext`,
  udp: (where) => `send UDP datagrams to ${where} and read what that address answers`,
}

/** The lines a dry run prints for the grants: what each peer could do, in words. */
export function describeGrants(options) {
  const lines = []
  for (const g of options.grants) {
    lines.push(`peer ${g.peer}${g.expiresAt ? ` (until ${new Date(g.expiresAt).toISOString()})` : ' (no expiry)'}:`)
    for (const p of g.parsed) {
      if (p.set) lines.push(`  ${p.scope}: ${p.action} to anything the set "${p.set}" lists: ${options.sets[p.set].join(' ')}`)
      else if (p.family === 'dns') lines.push(`  ${p.scope}: look up ${p.host ?? 'ANY name (wide mode)'}${p.wide ? '' : ' (A records)'}`)
      else {
        const host = p.host ?? 'ANY PUBLIC ADDRESS (wide mode)'
        const where = `${host}, ${p.port === '*' ? 'any port' : `port ${p.port}`}`
        lines.push(`  ${p.scope}: ${WHAT[p.family](where)}`)
      }
    }
  }
  return lines
}
