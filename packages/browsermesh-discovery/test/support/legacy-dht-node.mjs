// An "old node": the DHT store rules of browsermesh-discovery before owned stores, written out independently of
// src/dht.mjs. It accepts a DHT_STORE from anyone for any key, replaces what is there, ignores every message field
// it does not know (so an `auth` field is invisible to it), always replies `stored: true`, and answers a ping with
// no capabilities. test/dht-store-auth.test.mjs also proves a default (policy-less) DhtNode behaves the same.
import { DHT_PING, DHT_FIND_VALUE, DHT_STORE } from '../../src/dht.mjs'

export class LegacyDhtNode {
  #id; #send; #now; contacts = new Set(); entries = new Map()

  constructor({ localId, sendFn = () => {}, now = () => Date.now() }) { this.#id = localId; this.#send = sendFn; this.#now = now }

  get localId() { return this.#id }

  bootstrap(list) { for (const c of list) this.contacts.add(c.podId) }

  store(key, value, ttl = 0) {
    this.entries.set(key, { value, ttl, storedAt: this.#now() })
    for (const to of this.contacts) this.#send(to, { type: DHT_STORE, from: this.#id, key, value, ttl })
  }

  get(key) {
    const e = this.entries.get(key)
    if (!e) return undefined
    if (e.ttl > 0 && this.#now() > e.storedAt + e.ttl) { this.entries.delete(key); return undefined }
    return e.value
  }

  handleMessage(fromId, msg) {
    this.contacts.add(fromId)
    switch (msg.type) {
      case DHT_PING: return { type: DHT_PING, from: this.#id, pong: true }
      case DHT_FIND_VALUE: { const v = this.get(msg.key); return v === undefined ? { type: DHT_FIND_VALUE, from: this.#id, found: false, closest: [] } : { type: DHT_FIND_VALUE, from: this.#id, found: true, value: v } }
      case DHT_STORE:
        if (msg.key !== undefined && msg.value !== undefined) this.entries.set(msg.key, { value: msg.value, ttl: msg.ttl ?? 0, storedAt: this.#now() })
        return { type: DHT_STORE, from: this.#id, stored: true }
      default: return null
    }
  }
}
