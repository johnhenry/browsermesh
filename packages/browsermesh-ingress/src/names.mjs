/**
 * names.mjs -- names a pod may claim under the operator's zone, for as long as its link to the ingress is up.
 *
 * Off unless the operator builds a table and serves it: nothing here runs by default. The pieces:
 *
 *   createNameTable({ zone, allow, ... })       the rules: who may hold which label, how many, for how long after a link drops
 *   serveIngressNames(service, table)           the ingress end of protocol `ingress-names` v1 on the protocol channel
 *   openNameClient(service, ingressPodId)       the pod's end: claim / release / names over one channel
 *   registryAllow(registry)                     `allow` from a PeerRegistry: scope `ingress:name:<label>:claim`
 *
 * The pod a claim is for is always the channel's verified peer, never a field of a message. The table is pure (an injected
 * clock, no timers), so every rule is a plain function call in a test.
 */
import { ChannelErrorCode, MeshChannelError } from '@johnhenry/browsermesh-apps/mesh-channel'
import { createRateLimiter } from './limits.mjs'

export const NAMES_PROTOCOL = 'ingress-names'
export const NAMES_VERSIONS = Object.freeze([1])
/** The reason `openNameClient().close()` gives when it closes the channel: a goodbye, as opposed to a channel that simply went away. */
const GOODBYE_REASON = 'done'

/** Labels that are never claimable: they read as something an operator or a service owns. The operator maps these by hand. */
export const NAME_DENY_DEFAULTS = Object.freeze([
  'www', 'web', 'api', 'admin', 'administrator', 'root', 'mail', 'smtp', 'imap', 'pop', 'pop3', 'webmail', 'ftp', 'sftp', 'ssh', 'vpn', 'dns',
  'ns', 'ns1', 'ns2', 'ns3', 'mx', 'login', 'logon', 'signin', 'signup', 'auth', 'oauth', 'sso', 'secure', 'security', 'account', 'accounts',
  'billing', 'payment', 'payments', 'support', 'help', 'status', 'static', 'assets', 'cdn', 'git', 'ingress', 'egress', 'relay', 'signal',
  'signaling', 'mesh', 'wsh', 'localhost', 'internal', 'staging', 'dev', 'test', 'autoconfig', 'autodiscover',
])

/** A refusal with a named reason; over the wire it becomes a `MeshChannelError` with the same reason. */
export class NameRefusal extends Error {
  constructor(reason, message, extra = {}) {
    super(message || reason)
    this.name = 'NameRefusal'
    this.reason = reason
    if (extra.retryAfterMs !== undefined) this.retryAfterMs = extra.retryAfterMs
  }
}

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const SERVICE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const ZONE_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** A plain lowercase DNS label; no case folding. A hyphen in both the third and fourth place is refused (punycode, and what is made to look like it). */
export function checkLabel(label) {
  if (typeof label !== 'string' || !LABEL_RE.test(label) || (label[2] === '-' && label[3] === '-')) throw new NameRefusal('bad-name', 'A name is a lowercase DNS label: letters, digits and hyphens, 1 to 63 characters, no hyphen at either end or in the third and fourth places.')
  return label
}

export function checkService(service) {
  if (service !== undefined && (typeof service !== 'string' || !SERVICE_RE.test(service))) throw new NameRefusal('bad-service', 'A service is a short plain name.')
  return service
}

function denyMatcher(entries) {
  const exact = new Set()
  const prefixes = []
  for (const e of entries) {
    if (typeof e !== 'string' || !e) throw new TypeError('createNameTable: deny entries are strings (a trailing * matches a prefix)')
    if (e.endsWith('*')) prefixes.push(e.slice(0, -1))
    else exact.add(e)
  }
  return (label) => exact.has(label) || prefixes.some((p) => label.startsWith(p))
}

/**
 * @param {object} opts
 * @param {string} opts.zone - the hostname names live under: a claim for `app` is the host `app.<zone>`
 * @param {(pod: string, label: string) => (boolean|Promise<boolean>)} [opts.allow] - the operator's grant, per pod and name; only `true` allows, a throw or anything else refuses. Without it nothing is claimable.
 * @param {string[]} [opts.deny] - labels (a trailing `*` is a prefix) refused on top of `NAME_DENY_DEFAULTS`; a denied label is refused even when `allow` says yes
 * @param {number} [opts.maxNames=64] - names held at once in the whole zone (a name in its hold counts)
 * @param {number} [opts.maxPerPod=4]
 * @param {number} [opts.holdMs=30000] - how long a name stays its holder's after the holder's link goes; 0 frees it at once
 * @param {{ limit: number, windowMs: number }} [opts.claimRate] - claim attempts per pod per window, refused ones included
 * @param {(host: string) => boolean} [opts.reserved] - hosts the operator maps by hand: not claimable
 * @param {{ now: () => number }} [opts.clock]
 * @param {(record: object) => void} [opts.onAudit] - `{ type: 'name', action: 'claim'|'refuse'|'release'|'hold'|'expire', pod, name, reason? }`
 * @param {(event: object) => void} [opts.onChange] - `{ type: 'claimed'|'released'|'held'|'expired', pod, name, holdMs? }`
 */
export function createNameTable({
  zone, allow, deny = [], maxNames = 64, maxPerPod = 4, holdMs = 30_000, claimRate = { limit: 30, windowMs: 60_000 }, reserved, clock, onAudit, onChange,
} = {}) {
  if (typeof zone !== 'string' || !ZONE_RE.test(zone)) throw new TypeError('createNameTable: zone must be a lowercase hostname without a port')
  if (allow !== undefined && typeof allow !== 'function') throw new TypeError('createNameTable: allow must be a function')
  if (reserved !== undefined && typeof reserved !== 'function') throw new TypeError('createNameTable: reserved must be a function')
  for (const [k, v] of Object.entries({ maxNames, maxPerPod })) if (!Number.isSafeInteger(v) || v <= 0) throw new TypeError(`createNameTable: ${k} must be a positive integer`)
  if (!Number.isSafeInteger(holdMs) || holdMs < 0) throw new TypeError('createNameTable: holdMs must be a non-negative integer')
  if (!Array.isArray(deny)) throw new TypeError('createNameTable: deny must be a list')
  const denied = denyMatcher([...NAME_DENY_DEFAULTS, ...deny])
  const now = clock?.now ?? Date.now
  const rate = createRateLimiter(claimRate, { now })
  const names = new Map() // label -> { pod, link, service, heldUntil: number|null }
  const suffix = `.${zone}`

  const subscribers = new Set()
  const emit = (fn, record) => { if (fn) { try { fn(record) } catch { /* a sink never breaks the table */ } } }
  const changed = (event) => {
    for (const s of [...subscribers]) emit(s, event)
    emit(onChange, event)
  }
  const audit = (action, pod, name, reason) => emit(onAudit, { type: 'name', action, pod, name, ...(reason ? { reason } : {}) })
  const refuse = (pod, name, reason, message, extra) => { audit('refuse', pod, name, reason); return new NameRefusal(reason, message, extra) }

  // Held names whose hold has run out are removed whenever the table is read or written: there is no timer to leak.
  function sweep() {
    const t = now()
    for (const [label, e] of names) {
      if (e.heldUntil !== null && e.heldUntil <= t) {
        names.delete(label)
        audit('expire', e.pod, label)
        changed({ type: 'expired', pod: e.pod, name: label })
      }
    }
  }
  const countOf = (pod) => { let n = 0; for (const e of names.values()) if (e.pod === pod) n += 1; return n }

  return {
    zone,
    /** @returns {Promise<{ name: string, host: string, service: string|undefined }>} or throws `NameRefusal` */
    async claim(pod, label, { link, service } = {}) {
      const taken = rate.take(pod)
      if (!taken.ok) throw refuse(pod, label, 'claim-rate', 'Too many claims from this pod.', { retryAfterMs: taken.retryAfterMs })
      try { checkLabel(label); checkService(service) } catch (e) { throw refuse(pod, String(label).slice(0, 64), e.reason, e.message) }
      if (denied(label)) throw refuse(pod, label, 'denied-name', 'That name is not claimable.')
      const host = `${label}${suffix}`
      if (reserved && reserved(host)) throw refuse(pod, label, 'name-reserved', 'That host is mapped by the operator.')
      let ok = false
      if (allow) { try { ok = (await allow(pod, label)) === true } catch { ok = false } }
      if (!ok) throw refuse(pod, label, 'not-granted', 'This pod holds no grant for that name.')
      // Everything below is synchronous after the await: two claims that raced behind a slow `allow` meet here one at a time.
      sweep()
      const have = names.get(label)
      if (have && have.pod !== pod) throw refuse(pod, label, 'name-taken', 'That name is held by another pod.')
      if (!have) {
        if (countOf(pod) >= maxPerPod) throw refuse(pod, label, 'too-many-names', `A pod holds at most ${maxPerPod} names.`)
        if (names.size >= maxNames) throw refuse(pod, label, 'zone-full', 'This ingress has no names left to give.')
      }
      names.set(label, { pod, link, service, heldUntil: null })
      audit('claim', pod, label)
      changed({ type: 'claimed', pod, name: label, service })
      return { name: label, host, service }
    },

    /** The holder gives a name up. `{ link }`: only if it was claimed over that link. @returns {boolean} whether it held it */
    release(pod, label, { link } = {}) {
      sweep()
      const have = names.get(label)
      if (!have || have.pod !== pod) return false
      if (link !== undefined && have.link !== link) return false
      names.delete(label)
      audit('release', pod, label)
      changed({ type: 'released', pod, name: label })
      return true
    },

    /**
     * The link `link` of `pod` is gone: its names are held for `holdMs` for this pod only. A link that is not the one that made the claim changes nothing.
     * `{ hold: false }`: the link was closed on purpose (the pod said goodbye), so its names are given up at once instead of held, and nobody is told to wait for the pod.
     */
    linkLost(pod, link, { hold = true } = {}) {
      sweep()
      for (const [label, e] of [...names]) {
        if (e.pod !== pod || e.link !== link || e.heldUntil !== null) continue
        if (holdMs === 0 || !hold) { names.delete(label); audit('release', pod, label); changed({ type: 'released', pod, name: label }); continue }
        e.heldUntil = now() + holdMs
        audit('hold', pod, label)
        changed({ type: 'held', pod, name: label, holdMs })
      }
    },

    /** @returns {{ peer: string, service: string|undefined, name: string, held: boolean }|null} the holder of a host under the zone (a port is ignored) */
    lookup(host) {
      if (typeof host !== 'string') return null
      const h = host.toLowerCase().replace(/:\d{1,5}$/, '')
      if (!h.endsWith(suffix)) return null
      const label = h.slice(0, -suffix.length)
      sweep()
      const e = names.get(label)
      return e ? { peer: e.pod, service: e.service, name: label, held: e.heldUntil !== null } : null
    },

    /** What one pod holds. */
    namesOf(pod) {
      sweep()
      return [...names].filter(([, e]) => e.pod === pod).map(([name, e]) => ({ name, host: `${name}${suffix}`, service: e.service, held: e.heldUntil !== null }))
    },

    /** Changes (`claimed`, `released`, `held`, `expired`) as they happen; returns the function that stops listening. */
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('subscribe: a function is required')
      subscribers.add(listener)
      return () => subscribers.delete(listener)
    },

    stats() { sweep(); return { names: names.size, held: [...names.values()].filter((e) => e.heldUntil !== null).length } },
  }
}

/** `allow` for `createNameTable` from a PeerRegistry: the scope `ingress:name:<label>:claim` (a `*` label is every name). */
export function registryAllow(registry) {
  if (!registry || typeof registry.checkAccess !== 'function') throw new TypeError('registryAllow: a PeerRegistry with checkAccess is required')
  return (pod, label) => registry.checkAccess(pod, `ingress:name:${label}`, 'claim')?.allowed === true
}

const refusalCode = (reason) => (reason === 'not-granted' || reason === 'denied-name' || reason === 'name-reserved' ? ChannelErrorCode.UNAUTHORIZED
  : reason === 'claim-rate' || reason === 'zone-full' || reason === 'too-many-names' ? ChannelErrorCode.BUSY : ChannelErrorCode.INVALID)

function toChannelError(e) {
  if (e instanceof NameRefusal) return new MeshChannelError(refusalCode(e.reason), e.reason, e.message, e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : undefined)
  if (e instanceof MeshChannelError) return e
  return new MeshChannelError(ChannelErrorCode.INTERNAL, 'internal-error', 'the claim failed')
}

/**
 * Serve protocol `ingress-names` v1 on the ingress's protocol service: `claim { name, service? }`, `release { name }`, `names {}`.
 * Opening it is its own registry grant (`protocol:ingress-names:open`, default deny); each claim is then asked of the table's `allow`.
 * @param {object} service - a mesh service with the protocol channel
 * @param {ReturnType<typeof createNameTable>} table
 * @returns {{ stop(): void, stats(): object }}
 */
export function serveIngressNames(service, table) {
  const api = service && typeof service === 'object' ? (service.api ?? service) : null
  if (typeof api?.serveProtocol !== 'function') throw new TypeError('serveIngressNames: the first argument is a mesh service with serveProtocol (createMeshProtocolService)')
  if (!table || typeof table.claim !== 'function' || typeof table.linkLost !== 'function') throw new TypeError('serveIngressNames: a name table from createNameTable is required')
  const channels = new Set()
  const accept = (channel, { peer }) => {
    channels.add(channel)
    channel.onRequest('claim', async (params) => {
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw new MeshChannelError(ChannelErrorCode.INVALID, 'bad-request', 'a claim is { name, service? }')
      try { return await table.claim(peer, params.name, { link: channel, service: params.service }) } catch (e) { throw toChannelError(e) }
    })
    channel.onRequest('release', (params) => {
      if (!params || typeof params !== 'object' || typeof params.name !== 'string') throw new MeshChannelError(ChannelErrorCode.INVALID, 'bad-request', 'a release is { name }')
      return { released: table.release(peer, params.name) }
    })
    channel.onRequest('names', () => table.namesOf(peer))
    // A pod's goodbye: what this channel claimed is given up, the channel stays usable. (Only names of this pod, claimed over this channel.)
    channel.onRequest('bye', () => {
      const released = []
      for (const n of table.namesOf(peer)) if (!n.held && table.release(peer, n.name, { link: channel })) released.push(n.name)
      return { released }
    })
    // A channel that closed because the pod said `done` is a goodbye (names given up); any other close is a link that dropped (names held).
    channel.onClose(() => { channels.delete(channel); table.linkLost(peer, channel, { hold: channel.remoteReason !== GOODBYE_REASON }) })
  }
  const unserve = api.serveProtocol(NAMES_PROTOCOL, accept, { versions: [...NAMES_VERSIONS] })
  return {
    stop() { unserve(); for (const c of [...channels]) { try { c.close('stopped') } catch { /* gone */ } } channels.clear() },
    stats: () => ({ channels: channels.size, ...table.stats() }),
  }
}

/**
 * The pod's end: open `ingress-names` on the link to the ingress. The channel is the claim's lifetime: names are held while it
 * is open, held for a short while after it closes, and a pod that comes back claims them again on a new one.
 * @param {object} service - a mesh service with the protocol channel
 * @param {string} ingressPodId
 * @returns {Promise<{ channel: object, claim(name: string, opts?: { service?: string }): Promise<{ name: string, host: string }>, release(name: string): Promise<{ released: boolean }>, names(): Promise<object[]>, close(): void }>}
 */
export async function openNameClient(service, ingressPodId, { timeoutMs = 10_000, closeTimeoutMs = 2_000 } = {}) {
  const api = service && typeof service === 'object' ? (service.api ?? service) : null
  if (typeof api?.openProtocol !== 'function') throw new TypeError('openNameClient: the first argument is a mesh service with openProtocol (createMeshProtocolService)')
  if (!Number.isSafeInteger(closeTimeoutMs) || closeTimeoutMs <= 0) throw new TypeError('openNameClient: closeTimeoutMs must be a positive integer')
  const channel = await api.openProtocol(ingressPodId, NAMES_PROTOCOL, { versions: [...NAMES_VERSIONS], timeoutMs })
  return {
    channel,
    claim: (name, { service: svc } = {}) => channel.request('claim', { name, ...(svc === undefined ? {} : { service: svc }) }, { timeoutMs }),
    release: (name) => channel.request('release', { name }, { timeoutMs }),
    names: () => channel.request('names', {}, { timeoutMs }),
    onClose: (cb) => channel.onClose(cb),
    /**
     * Say goodbye and close: the names this channel claimed are given up at once (not held for the pod to come back), and
     * this resolves once the ingress has answered, so the goodbye is on its way before whatever the caller closes next (the
     * node) can cut it off. An ingress that does not know the request, or one that does not answer within `closeTimeoutMs`,
     * does not hold the close up: the channel is closed all the same, with the reason `done` that an ingress reads as a goodbye
     * too. Call it before closing the node, and `await` it.
     * @returns {Promise<void>}
     */
    async close() {
      if (channel.closed) return
      try { await channel.request('bye', {}, { timeoutMs: closeTimeoutMs }) } catch { /* an older ingress, or none: the close below says it */ }
      channel.close(GOODBYE_REASON)
    },
  }
}
