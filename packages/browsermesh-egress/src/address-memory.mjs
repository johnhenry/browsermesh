/**
 * address-memory.mjs -- which names a link's own lookups returned an address for, bounded in time and in count.
 *
 * A guest operating system connects to the ADDRESS its lookup returned; a grant is written for a NAME. This is the small memory
 * that joins them, and it is used on both ends of a link for the same purpose:
 *
 *   - a provider remembers what ITS OWN resolver answered for each consumer, so that a `connect` to such an address can be taken
 *     as a connect to the name under the name's grant (`connectByResolvedAddress`). The address is never taken from the consumer.
 *   - a consumer remembers what a provider answered to its own lookups, so that it can ask for the name when a provider will not
 *     take the address (`mapAddresses`).
 *
 * Nothing here decides anything about access. It holds pairs (address, name) that were answered, each for `ttlMs` from the moment
 * it was answered (a new answer renews it), at most `maxEntries` pairs in all (the oldest go first), and gives them back newest
 * first. IPv4 dotted quads only, as the lookup form answers nothing else. No `node:` import.
 */

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/

/**
 * @param {{ ttlMs: number, maxEntries: number, now?: () => number }} opts
 * @returns {{ remember(name: string, addresses: unknown[]): void, namesFor(address: string): string[], readonly size: number, clear(): void }}
 */
export function createAddressMemory({ ttlMs, maxEntries, now = Date.now } = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new TypeError('createAddressMemory: ttlMs must be a positive integer')
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) throw new TypeError('createAddressMemory: maxEntries must be a positive integer')
  const entries = new Map() // `${address} ${name}` -> { address, name, expires }, oldest first

  const purge = () => {
    const t = now()
    for (const [key, e] of entries) if (e.expires <= t) entries.delete(key)
  }

  return {
    remember(name, addresses) {
      if (typeof name !== 'string' || !name || !Array.isArray(addresses)) return
      const expires = now() + ttlMs
      for (const address of addresses) {
        if (typeof address !== 'string' || !IPV4.test(address)) continue
        const key = `${address} ${name}`
        entries.delete(key) // a renewal moves it to the newest end and does not count twice
        entries.set(key, { address, name, expires })
      }
      purge()
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value)
    },
    /** The names this address was answered for, most recent first. */
    namesFor(address) {
      purge()
      const out = []
      for (const e of entries.values()) if (e.address === address) out.unshift(e.name)
      return out
    },
    get size() { purge(); return entries.size },
    clear() { entries.clear() },
  }
}
