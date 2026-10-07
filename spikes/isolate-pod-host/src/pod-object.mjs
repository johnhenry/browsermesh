/**
 * pod-object.mjs — Durable Object that hosts one `Pod` (issue #185 WP2).
 *
 * One Durable Object instance == one hosted isolate pod. Identity (an
 * Ed25519 `PodIdentity`) is persisted in `ctx.storage` as JWK so the same
 * pod comes back with the same `podId` across evictions and restarts. The
 * pod itself boots on `@johnhenry/browsermesh-pod`'s `WebSocketTransport`
 * (WP1 of #185) against the relay/signaling servers named by the
 * `RELAY_URL` / `SIGNALING_URL` vars, wrapped in a `TransportDiscovery` so
 * it runs the normal pod:hello/pod:hello-ack discovery protocol.
 *
 * Routes (all called by the Worker in `worker.mjs` via `stub.fetch(...)`):
 *   POST /boot   — idempotent; boots the pod if not already booted.
 *                  Body `{name, spec}`: the normalized podspec is persisted
 *                  in `ctx.storage` so `/status` can report it back and a
 *                  restarted DO still knows what it was asked to run.
 *   GET  /status — the protocol's pod-status shape (`name`, `lane`, `state`,
 *                  `spec`, `createdAt`, `updatedAt`, `podId`) PLUS the
 *                  WP2-era fields (`kind`, `role`, `peers`, `booted`) the
 *                  original end-to-end test asserts on.
 *   POST /send   — { to, payload } → pod.send(to, payload)
 *   POST /drain  — shut the pod down, close the transport, mark it `gone`
 *
 * One DO instance, `idFromName('__roster__')`, is used by the Worker as a
 * plain list of spawned pod names rather than as a pod (a DO namespace
 * cannot be enumerated). It answers the `/roster*` routes below and never
 * boots anything.
 *
 * Keepalive: `ctx.storage.setAlarm()` every 30s; `alarm()` re-arms itself
 * and nudges the transport to reconnect if it dropped.
 *
 * Hibernation: NOT used, and cannot be with this topology — see the
 * "What wasn't achievable" section of ../README.md. Short version: the DO
 * is a WebSocket *client* of the relay/signaling servers, and the
 * Hibernation API only covers WebSockets the DO *accepts* as a server.
 */

import {
  Pod, TransportDiscovery, POD_MESSAGE, WebSocketTransport,
  POD_LANE, POD_LIFECYCLE,
} from '@johnhenry/browsermesh-pod'
import { WorkerClientWebSocket } from './worker-websocket.mjs'
import { loadOrCreateIdentity } from './identity-jwk.mjs'

// cloudflare:workers' DurableObject base class supplies `this.ctx` / `this.env`
// and makes RPC methods callable directly on the stub; we still route
// everything through fetch() here to keep the Worker <-> DO boundary a
// plain HTTP contract that's easy to test and easy to port to a different
// host later.
import { DurableObject } from 'cloudflare:workers'

const KEEPALIVE_MS = 30_000
const DISCOVERY_TIMEOUT_MS = 1500

/**
 * Pod subclass that answers `{ ping: true, t0 }` payloads with
 * `{ pong: true, t0 }` so callers can measure message round-trip time
 * through the relay without needing a second mechanism.
 */
class EchoPod extends Pod {
  _onMessage(msg) {
    if (msg.type !== POD_MESSAGE) return
    const payload = msg.payload
    if (payload && payload.ping === true && msg.from) {
      this.send(msg.from, { pong: true, t0: payload.t0 })
    }
  }
}

export class PodObject extends DurableObject {
  /** @type {EchoPod|null} */
  #pod = null
  /** @type {WebSocketTransport|null} */
  #transport = null
  /** @type {Promise<object>|null} */
  #bootPromise = null
  #bootedAtMs = null

  /**
   * @param {DurableObjectState} ctx
   * @param {object} env
   */
  constructor(ctx, env) {
    super(ctx, env)
    this.ctx = ctx
    this.env = env
  }

  /** @param {Request} request */
  async fetch(request) {
    const url = new URL(request.url)
    try {
      if (request.method === 'POST' && url.pathname === '/boot') {
        const raw = await request.text()
        const body = raw.trim().length > 0 ? JSON.parse(raw) : {}
        return Response.json(await this.#boot(body))
      }
      if (request.method === 'GET' && url.pathname === '/status') {
        return Response.json(await this.#status())
      }
      if (request.method === 'POST' && url.pathname === '/send') {
        const body = await request.json()
        return Response.json(await this.#send(body))
      }
      if (request.method === 'POST' && url.pathname === '/drain') {
        return Response.json(await this.#drain())
      }
      // Roster routes — only ever addressed on the '__roster__' instance.
      if (request.method === 'GET' && url.pathname === '/roster') {
        return Response.json({ names: (await this.ctx.storage.get('roster')) || [] })
      }
      if (request.method === 'POST' && (url.pathname === '/roster/add' || url.pathname === '/roster/remove')) {
        const { name } = await request.json()
        const names = new Set((await this.ctx.storage.get('roster')) || [])
        if (url.pathname.endsWith('/add')) names.add(name)
        else names.delete(name)
        const next = [...names]
        await this.ctx.storage.put('roster', next)
        return Response.json({ names: next })
      }
      return Response.json({ code: 'ENOENT', message: 'not found' }, { status: 404 })
    } catch (err) {
      return Response.json(
        { error: String((err && err.stack) || err) },
        { status: 500 }
      )
    }
  }

  /** Alarm handler — keepalive + reconnect-if-dropped, then re-arms itself. */
  async alarm() {
    if (this.#pod && this.#transport) {
      if (!this.#transport.ready) {
        console.log('[pod-object] alarm: transport not ready, attempting reconnect')
        try {
          await this.#transport.open()
        } catch (err) {
          console.log(`[pod-object] alarm: reconnect failed: ${err && err.message}`)
        }
      } else {
        const peers = [...this.#pod.peers.keys()]
        console.log(`[pod-object] alarm: alive, podId=${this.#pod.podId} peers=[${peers.join(',')}]`)
      }
    }
    await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS)
  }

  // ── Routes ───────────────────────────────────────────────────────

  async #boot(body = {}) {
    // Persist what we were asked to run BEFORE booting, so a crashed boot
    // still leaves a record a later /status can report.
    const existing = (await this.ctx.storage.get('record')) || null
    const record = {
      name: body.name ?? existing?.name ?? null,
      spec: body.spec ?? existing?.spec ?? null,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      state: POD_LIFECYCLE.BOOTING,
    }
    await this.ctx.storage.put('record', record)

    if (this.#bootPromise) return this.#bootPromise
    this.#bootPromise = this.#doBoot().catch((err) => {
      // Allow a subsequent /boot call to retry after a failure.
      this.#bootPromise = null
      throw err
    })
    return this.#bootPromise
  }

  async #doBoot() {
    if (this.#pod && this.#pod.state === 'ready') {
      await this.#updateRecord({ state: POD_LIFECYCLE.REGISTERED })
      return { ...(await this.#statusSnapshot()), alreadyBooted: true, bootMs: 0 }
    }

    const t0 = Date.now()
    const identity = await loadOrCreateIdentity(this.ctx.storage)

    const transport = new WebSocketTransport({
      url: this.env.RELAY_URL,
      podId: identity.podId,
      WebSocket: WorkerClientWebSocket,
      signalingUrl: this.env.SIGNALING_URL,
      peersFromSignaling: true,
      onLog: (msg) => console.log(msg),
    })

    const discovery = new TransportDiscovery({
      transport,
      localPodId: identity.podId,
      localKind: 'server',
      timeout: DISCOVERY_TIMEOUT_MS,
    })

    const pod = new EchoPod()
    pod.on('peer:found', (info) => console.log(`[pod-object] peer found: ${info.podId}`))
    pod.on('peer:lost', (info) => console.log(`[pod-object] peer lost: ${info.podId}`))
    pod.on('error', (info) => console.log(`[pod-object] boot error: ${info.error && info.error.message}`))

    // `pod.boot()` always waits out the full DISCOVERY_TIMEOUT_MS window
    // (TransportDiscovery.start() is a fixed setTimeout, not "resolve as
    // soon as a peer answers"), so bootMs below is dominated by that fixed
    // wait, not by how long the relay/signaling handshake actually took.
    // Poll `transport.ready` concurrently to capture the real
    // spawn-to-registered latency separately — this is the number that
    // maps onto issue #185 §9's "Spawn → registered on signaling" row.
    const registeredAtPromise = (async () => {
      while (!transport.ready) await new Promise((r) => setTimeout(r, 5))
      return Date.now()
    })()

    await pod.boot({
      identity,
      transport,
      discovery,
      discoveryChannel: this.env.DISCOVERY_CHANNEL,
    })
    const registeredAtMs = await registeredAtPromise

    this.#pod = pod
    this.#transport = transport
    this.#bootedAtMs = Date.now()

    await this.#updateRecord({ state: POD_LIFECYCLE.REGISTERED })
    await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS)

    return {
      ...(await this.#statusSnapshot()),
      alreadyBooted: false,
      bootMs: Date.now() - t0,
      registeredMs: registeredAtMs - t0,
    }
  }

  async #status() {
    if (this.#pod) return this.#statusSnapshot()
    // Not booted (yet, or since the last eviction) — report the persisted
    // podId if we have one so callers can tell "known but asleep" apart
    // from "never booted".
    const stored = await this.ctx.storage.get('identity')
    return {
      ...(await this.#protocolFields()),
      podId: stored ? stored.podId : null,
      kind: null,
      role: null,
      peers: [],
      booted: false,
    }
  }

  async #statusSnapshot() {
    if (!this.#pod) {
      return { ...(await this.#protocolFields()), podId: null, kind: null, role: null, peers: [], booted: false }
    }
    return {
      ...(await this.#protocolFields()),
      podId: this.#pod.podId,
      kind: this.#pod.kind,
      role: this.#pod.role,
      peers: [...this.#pod.peers.keys()],
      booted: this.#pod.state === 'ready',
      bootedAtMs: this.#bootedAtMs,
    }
  }

  /**
   * The `PodHostStatus` fields of the shared protocol, read back out of
   * durable storage. Merged UNDER the WP2-era fields above so `podId`
   * always reflects the live pod when there is one.
   * @returns {Promise<object>}
   */
  async #protocolFields() {
    const record = (await this.ctx.storage.get('record')) || null
    return {
      name: record?.name ?? null,
      lane: POD_LANE.ISOLATE,
      state: record?.state ?? POD_LIFECYCLE.COLD,
      spec: record?.spec ?? null,
      createdAt: record?.createdAt ?? 0,
      updatedAt: record?.updatedAt ?? 0,
    }
  }

  /**
   * @param {object} patch
   * @returns {Promise<object>} The merged record.
   */
  async #updateRecord(patch) {
    const record = { ...((await this.ctx.storage.get('record')) || {}), ...patch, updatedAt: Date.now() }
    await this.ctx.storage.put('record', record)
    return record
  }

  /**
   * Drain: shut the pod down (which sends `pod:goodbye` to its peers),
   * close the transport so the relay/signaling sockets go away, cancel the
   * keepalive alarm, and mark the pod `gone`. Idempotent.
   * @returns {Promise<object>}
   */
  async #drain() {
    if (this.#pod) {
      try {
        await this.#pod.shutdown({ silent: false })
      } catch (err) {
        console.log(`[pod-object] drain: shutdown failed: ${err && err.message}`)
      }
    }
    if (this.#transport) {
      try {
        this.#transport.close()
      } catch (err) {
        console.log(`[pod-object] drain: transport close failed: ${err && err.message}`)
      }
    }
    this.#pod = null
    this.#transport = null
    this.#bootPromise = null
    this.#bootedAtMs = null
    await this.ctx.storage.deleteAlarm()
    await this.#updateRecord({ state: POD_LIFECYCLE.GONE })
    return { ...(await this.#protocolFields()), podId: null, kind: null, role: null, peers: [], booted: false }
  }

  async #send({ to, payload }) {
    if (!this.#pod || this.#pod.state !== 'ready') {
      return { ok: false, error: 'pod not booted — POST /boot first' }
    }
    if (!to) {
      return { ok: false, error: '"to" is required' }
    }
    this.#pod.send(to, payload)
    return { ok: true, sentAtMs: Date.now() }
  }
}
