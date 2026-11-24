/**
 * channel-advertisement.mjs -- say, and learn, that a peer runs the message
 * channel (`mesh-channel.mjs`) and which layered protocols it serves
 * (`protocol-channel.mjs`), without opening a link to find out.
 *
 * A peer that serves the channel puts `channelAdvertisement(...)` into what it
 * already announces (the `capabilities` list and `metadata` of its
 * runtime-registry record, the place pod hosts use for `pod-host`). A peer that
 * wants to open a channel reads that record with `readChannelAdvertisement()`
 * and passes `peerSupportsFromAdvertisements(lookup)` as the `peerSupports`
 * option of `createMeshChannelService()` / `createMeshProtocolService()`.
 *
 * What it can and cannot say. An advertisement is the peer's own claim: it
 * saves a handshake, it proves nothing and authorises nothing (opening a
 * protocol is still gated by `protocol:<name>:open`). A peer that advertises
 * nothing, or advertises other things only, is UNKNOWN, and the channel is
 * tried as before: `peerSupports` only ever says "no" when a peer advertised a
 * channel version range that cannot overlap ours. An older peer that advertises
 * nothing is unaffected; an older peer reading an advertisement ignores the
 * extra capability strings and metadata key.
 *
 * No browser-only imports.
 */
import { CHANNEL_VERSION, CHANNEL_MIN_VERSION } from './mesh-channel.mjs'

/** The capability string a peer serving the channel advertises. */
export const CHANNEL_CAPABILITY = 'mesh-channel'

const NAME = /^[a-z0-9._-]{1,64}$/
const MAX_PROTOCOLS = 64
const MAX_VERSIONS = 16

/** @param {unknown} v @returns {boolean} */
const isVersion = v => Number.isInteger(v) && v >= 1 && v <= 1_000_000

/**
 * What to add to this peer's announcement.
 *
 * @param {{protocols?: Record<string, number[]>}} [opts] protocol name to the versions served
 * @returns {{capabilities: string[], metadata: {meshChannel: {version: number, minVersion: number, protocols: Record<string, number[]>}}}}
 */
export function channelAdvertisement({ protocols = {} } = {}) {
  const out = {}
  for (const name of Object.keys(protocols).sort()) {
    if (!NAME.test(name)) throw new TypeError(`channelAdvertisement: protocol name '${name}' must match [a-z0-9._-]{1,64}`)
    const versions = protocols[name]
    if (!Array.isArray(versions) || versions.length === 0 || !versions.every(isVersion)) {
      throw new TypeError(`channelAdvertisement: versions of '${name}' must be a non-empty list of positive integers`)
    }
    out[name] = [...new Set(versions)].sort((a, b) => a - b)
  }
  return {
    capabilities: [CHANNEL_CAPABILITY, ...Object.keys(out).map(name => `protocol:${name}`)],
    metadata: { meshChannel: { version: CHANNEL_VERSION, minVersion: CHANNEL_MIN_VERSION, protocols: out } },
  }
}

/**
 * Read a peer record (`{capabilities, metadata}`) defensively.
 *
 * @param {unknown} record
 * @returns {null | {version: number, minVersion: number, protocols: Record<string, number[]>}}
 *   `null` when the peer did not advertise the channel (unknown), else what it advertised,
 *   keeping only well-formed protocol entries.
 */
export function readChannelAdvertisement(record) {
  if (!record || typeof record !== 'object') return null
  const caps = record.capabilities
  if (!Array.isArray(caps) || !caps.includes(CHANNEL_CAPABILITY)) return null
  const meta = record.metadata?.meshChannel
  const version = isVersion(meta?.version) ? meta.version : CHANNEL_VERSION
  const minVersion = isVersion(meta?.minVersion) ? meta.minVersion : version
  const protocols = {}
  const raw = meta && typeof meta.protocols === 'object' && meta.protocols !== null ? meta.protocols : {}
  for (const name of Object.keys(raw).slice(0, MAX_PROTOCOLS)) {
    if (!NAME.test(name) || !Array.isArray(raw[name])) continue
    const versions = [...new Set(raw[name].filter(isVersion))].sort((a, b) => a - b).slice(0, MAX_VERSIONS)
    if (versions.length > 0) protocols[name] = versions
  }
  return { version, minVersion, protocols }
}

/**
 * Whether an advertisement says a protocol can be opened.
 *
 * @param {ReturnType<typeof readChannelAdvertisement>} advertisement
 * @param {string} name
 * @param {number[]} versions the versions we can speak
 * @returns {boolean|undefined} `undefined` when the peer advertised nothing (unknown)
 */
export function advertisedProtocolSupport(advertisement, name, versions) {
  if (!advertisement) return undefined
  const served = Object.hasOwn(advertisement.protocols, name) ? advertisement.protocols[name] : []
  return versions.some(v => served.includes(v))
}

/**
 * A `peerSupports` hook for `createMeshChannelService()` from a lookup of peer
 * records. It answers `false` only when the peer advertised a channel version
 * range that cannot overlap ours; otherwise `true` (advertised) or `undefined`
 * (unknown: the channel is tried). A lookup that throws is unknown.
 *
 * @param {(peer: string) => ({capabilities?: string[], metadata?: object}|null|undefined)} lookup
 * @returns {(peer: string) => (boolean|undefined)}
 */
export function peerSupportsFromAdvertisements(lookup) {
  return peer => {
    let advertisement
    try { advertisement = readChannelAdvertisement(lookup(peer)) } catch { return undefined }
    if (!advertisement) return undefined
    const overlaps = advertisement.minVersion <= CHANNEL_VERSION && advertisement.version >= CHANNEL_MIN_VERSION
    return overlaps ? true : false
  }
}
