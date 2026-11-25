/**
 * destination.mjs -- what a destination is, how it is written in a grant, and how an operator's sets match it.
 *
 * Nothing here classifies an address: whether an address is public, private, loopback and so on is wsh's address guard's
 * decision (see `./node`), and it is made on the address a name RESOLVES to. This file only parses what a request or an
 * operator wrote: a host syntax, a port, a scope, a set entry, an IPv4 block.
 *
 * No `node:` imports.
 */
import { EgressError } from './errors.mjs'

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const NUMERIC_LABEL = /^(?:0x[0-9a-f]*|[0-9]+)$/i
const IPV4 = /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/
const POD_ID = /^[A-Za-z0-9_-]{43}$/

/** Does this look like a mesh pod id (an address on the mesh, never a destination on a network)? */
export const looksLikePodId = (s) => typeof s === 'string' && POD_ID.test(s)

export function isCanonicalIPv4(text) {
  return typeof text === 'string' && IPV4.test(text) && text.split('.').every((o) => Number(o) <= 255)
}

/**
 * A destination host as a request may carry it: a lowercase DNS name, or a canonical IPv4 dotted quad. Anything else is
 * `bad-destination`: upper case, a trailing dot, a port or a path in it, an IPv6 literal (not accepted in this version), a
 * name of digits only, and every spelling of an IPv4 address other than four plain decimal numbers (`127.1`, `0177.0.0.1`,
 * `0x7f.1`, `2130706433`), so that no rule ever sees two spellings of one address.
 * @returns {{ host: string, kind: 'name'|'ipv4' }}
 */
export function checkHost(host) {
  if (typeof host !== 'string' || host.length === 0 || host.length > 253) throw new EgressError('bad-destination', 'The host is empty or too long.')
  if (host.includes(':')) throw new EgressError('bad-destination', 'The host has a colon in it: IPv6 literals are not accepted in this version, and the port goes in `port`.')
  const labels = host.split('.')
  if (!labels.every((l) => l.length > 0)) throw new EgressError('bad-destination', 'The host has an empty label (a trailing or doubled dot).')
  if (labels.every((l) => NUMERIC_LABEL.test(l))) {
    if (isCanonicalIPv4(host)) return { host, kind: 'ipv4' }
    throw new EgressError('bad-destination', 'A numeric host must be four plain decimal numbers (a.b.c.d).')
  }
  if (!labels.every((l) => LABEL.test(l))) throw new EgressError('bad-destination', 'The host is not a lowercase DNS name (letters, digits and hyphens in labels).')
  return { host, kind: 'name' }
}

/** A name to look up: a DNS name, never an address. */
export function checkName(name) {
  const { host, kind } = checkHost(name)
  if (kind !== 'name') throw new EgressError('bad-destination', 'An address is not looked up: only a name.')
  return host
}

export function checkPort(port) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new EgressError('bad-destination', 'The port is not a whole number from 1 to 65535.')
  return port
}

/** The scopes a grant is written in. `host` and `name` are as `checkHost` returns them: no `:` and no `*` can be in one. */
export const EGRESS_SCOPES = Object.freeze({
  /** Open TCP to exactly this host and port. */
  tcp: (host, port) => `egress:tcp:${host}:${port}:connect`,
  /** Open TCP to any port of exactly this host (the provider's blocked ports still apply). */
  tcpAnyPort: (host) => `egress:tcp:${host}:*:connect`,
  /** Look up exactly this name. */
  dns: (name) => `egress:dns:${name}:resolve`,
  /** Connect to anything the operator's set of this name lists. */
  set: (name) => `egress:set:${name}:connect`,
})

const SET_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** @returns {number[]|null} a canonical IPv4 as four numbers */
function octets(text) { return isCanonicalIPv4(text) ? text.split('.').map(Number) : null }
const toInt = ([a, b, c, d]) => (((a * 256 + b) * 256 + c) * 256 + d)

function parsePorts(text, where) {
  if (text === '*') return '*'
  const ranges = []
  for (const part of text.split(',')) {
    const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(part)
    if (!m) throw new TypeError(`${where}: ports must be \`*\`, or numbers and ranges such as 80,443,8000-8100 (got ${JSON.stringify(text)})`)
    const lo = Number(m[1])
    const hi = m[2] === undefined ? lo : Number(m[2])
    if (lo < 1 || hi > 65535 || lo > hi) throw new TypeError(`${where}: port range ${part} is outside 1-65535 or reversed`)
    ranges.push([lo, hi])
  }
  return ranges
}

/**
 * One entry of an operator's destination set:
 *   `registry.npmjs.org:443`        an exact name
 *   `*.alpinelinux.org:80,443`      any subdomain, never the apex; at least two labels after the star
 *   `203.0.113.7:443`               an IPv4 literal
 *   `203.0.113.0/24:443`            an IPv4 block (matches destinations given as IP literals)
 *   ports: `*`, or numbers and ranges (`80,443,8000-8100`)
 * A bare `*` host, `*:443`, `*.com` and IPv6 are refused: wide access is a mode (`wide`), never a set.
 * @returns {{ text: string, kind: 'name'|'suffix'|'ipv4'|'cidr', host?: string, suffix?: string, base?: number, mask?: number, ports: '*'|number[][] }}
 */
export function parseSetEntry(entry, where = 'set entry') {
  if (typeof entry !== 'string' || !entry) throw new TypeError(`${where}: an entry is a non-empty string`)
  const at = entry.lastIndexOf(':')
  if (at <= 0) throw new TypeError(`${where}: ${JSON.stringify(entry)} needs host:ports`)
  const hostSpec = entry.slice(0, at)
  const ports = parsePorts(entry.slice(at + 1), `${where} ${JSON.stringify(entry)}`)
  if (hostSpec === '*' || hostSpec.includes('*') && !hostSpec.startsWith('*.')) throw new TypeError(`${where}: ${JSON.stringify(entry)}: a bare or partial wildcard host is never a set entry (wide access is the \`wide\` mode)`)
  if (hostSpec.startsWith('*.')) {
    const suffix = hostSpec.slice(2)
    let ok = true
    try { ok = checkHost(suffix).kind === 'name' } catch { ok = false }
    if (!ok || suffix.split('.').length < 2) throw new TypeError(`${where}: ${JSON.stringify(entry)}: a \`*.suffix\` needs a DNS suffix of at least two labels (\`*.example.com\`)`)
    return { text: entry, kind: 'suffix', suffix, ports }
  }
  if (hostSpec.includes('/')) {
    const [base, bits, extra] = hostSpec.split('/')
    const o = octets(base)
    const n = /^\d{1,2}$/.test(bits ?? '') ? Number(bits) : -1
    if (!o || extra !== undefined || n < 0 || n > 32) throw new TypeError(`${where}: ${JSON.stringify(entry)}: a block is a.b.c.d/0-32 (IPv4 only)`)
    const mask = n === 0 ? 0 : (0xffffffff << (32 - n)) >>> 0
    if ((toInt(o) & mask) >>> 0 !== toInt(o)) throw new TypeError(`${where}: ${JSON.stringify(entry)}: the block has bits set below its prefix`)
    return { text: entry, kind: 'cidr', base: toInt(o), mask, ports }
  }
  let parsed
  try { parsed = checkHost(hostSpec) } catch (e) { throw new TypeError(`${where}: ${JSON.stringify(entry)}: ${e.message}`) }
  return parsed.kind === 'ipv4' ? { text: entry, kind: 'ipv4', host: parsed.host, ports } : { text: entry, kind: 'name', host: parsed.host, ports }
}

const portIn = (ports, port) => ports === '*' || ports.some(([lo, hi]) => port >= lo && port <= hi)

/** Does one parsed entry cover this destination? `host` and `kind` are as `checkHost` returned them. */
export function entryMatches(entry, host, kind, port) {
  if (!portIn(entry.ports, port)) return false
  switch (entry.kind) {
    case 'name': return kind === 'name' && host === entry.host
    case 'suffix': return kind === 'name' && host.length > entry.suffix.length + 1 && host.endsWith(`.${entry.suffix}`)
    case 'ipv4': return kind === 'ipv4' && host === entry.host
    case 'cidr': return kind === 'ipv4' && ((toInt(host.split('.').map(Number)) & entry.mask) >>> 0) === entry.base
    default: return false
  }
}

/**
 * The operator's sets, parsed once at construction. A set's name is a scope segment (`egress:set:<name>:connect`).
 * @param {Record<string, string[]>} sets
 * @returns {Map<string, ReturnType<typeof parseSetEntry>[]>}
 */
export function compileSets(sets = {}) {
  if (!sets || typeof sets !== 'object' || Array.isArray(sets)) throw new TypeError('sets must be an object of set name to a list of entries')
  const out = new Map()
  for (const [name, entries] of Object.entries(sets)) {
    if (!SET_NAME.test(name)) throw new TypeError(`sets: ${JSON.stringify(name)} is not a set name (lowercase letters, digits, . _ -; it is a scope segment, so no colon or star)`)
    if (!Array.isArray(entries) || entries.length === 0) throw new TypeError(`sets.${name}: a non-empty list of entries is required`)
    out.set(name, entries.map((e) => parseSetEntry(e, `sets.${name}`)))
  }
  return out
}

/** @returns {string[]} the names of the sets that list this destination */
export function setsCovering(compiled, host, kind, port) {
  const names = []
  for (const [name, entries] of compiled) if (entries.some((e) => entryMatches(e, host, kind, port))) names.push(name)
  return names
}
