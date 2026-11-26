/**
 * realm-wiring.mjs -- `createMeshNode({ realm })` (docs/design/realms.md sections 4, 5.5, 5.7, 7).
 *
 *   const prepared = await prepareRealm({ realm, registry, onLog })     // before the node: gives the admission seam
 *   const api = attachRealm(node, prepared, { servicesNetwork, onLog }) // after the node: node.realm
 *
 * `@johnhenry/browsermesh-realm` is private and unpublished, so apps never imports it statically: `prepareRealm` `import()`s it
 * lazily and fails with a clear error when it is absent (the same convention as the other optional peers).
 *
 * One realm per node ("one node per realm"). What this module owns:
 *   - the descriptor store (`held` from `persist.load()`, saved with `persist.save()` on every adoption);
 *   - the verifier (host side) and the link-admission seam that carries it, sized for descriptor frames, on both transports;
 *   - the dialler: `present()` (and the automatic path) over a fresh link, `renew()` over the `realm` protocol;
 *   - the `realm` protocol (renewal, and descriptor updates for peers that already hold a grant), served on the node's
 *     `mesh-protocols` service and open ONLY to a peer that holds a live grant of this realm (no new scope);
 *   - one auto-renew timer for the whole realm, cleared at shutdown.
 *
 * Renewal runs the SAME verification pipeline as the exchange: the verifier's handler is handed a link-shaped view of the
 * protocol channel (`peerKey` is the channel's verified peer, so a credential is checked against the key the link proved),
 * so subject, tracker ordering and the registry grant replace are the verifier's own code, not a copy.
 */
import { createLinkAdmission } from '../link-admission.mjs'
import { createMeshProtocolService } from '../protocol-channel.mjs'
import { attachService } from '../mesh-service.mjs'
import { nodeChannel, protocolChannel } from './realm-channel.mjs'

const PROTOCOL = 'realm'
const LINK_RESOURCE = 'mesh:link'
const LINK_ACTION = 'connect'
const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_BEFORE_SECONDS = 300
/** Never re-arm sooner than this: a provider that keeps handing back a nearly-expired credential cannot make a hot loop. */
const MIN_RENEW_DELAY_MS = 1_000
/** After a round the provider could not serve. */
const RETRY_RENEW_MS = 30_000
/** How long a finished renewal waits for the host to end the channel before it ends it itself. */
const CLOSE_WAIT_MS = 500

const bad = (what) => new TypeError(`createMeshNode: realm option: ${what}`)

/**
 * @param {object} opts
 * @param {object} opts.realm the `realm` option of `createMeshNode`
 * @param {object} opts.registry the node's PeerRegistry
 * @param {Function} [opts.onLog]
 */
export async function prepareRealm({ realm, registry, onLog = () => {} }) {
  if (!realm || typeof realm !== 'object') throw bad('an object is required')
  const { pinnedId, descriptor, policy = {}, persist, loadRealmPackage } = realm
  if (typeof pinnedId !== 'string' || pinnedId === '') throw bad('pinnedId (the realm id this node honours) is required')
  if (descriptor !== undefined && typeof descriptor !== 'string') throw bad('descriptor is the signed descriptor text')
  if (persist !== undefined && (!persist || typeof persist.save !== 'function')) throw bad('persist is { load(), save(text) }')
  if (realm.autoRenew !== undefined && typeof realm.autoRenew?.credentialProvider !== 'function') throw bad('autoRenew needs a credentialProvider function')

  let pkg
  try {
    pkg = await (loadRealmPackage ? loadRealmPackage() : import('@johnhenry/browsermesh-realm'))
  } catch (cause) {
    throw new Error('createMeshNode: the realm option needs @johnhenry/browsermesh-realm (it is a private, unpublished workspace package: add it as a dependency of your app)', { cause })
  }

  registry.setRealmPolicy(policy)
  const emit = (event) => { try { realm.onEvent?.(event) } catch { /* a listener may not break a link */ } }

  let held
  if (typeof persist?.load === 'function') {
    try { held = (await persist.load()) ?? undefined } catch (cause) { throw new Error('createMeshNode: realm option: persist.load() failed', { cause }) }
  }
  const save = (text) => {
    if (!persist) return
    try {
      Promise.resolve(persist.save(text)).catch((err) => onLog('mesh-bootstrap:realm-persist-failed', { error: err?.message || String(err) }))
    } catch (err) { onLog('mesh-bootstrap:realm-persist-failed', { error: err?.message || String(err) }) }
  }
  const store = pkg.createDescriptorStore({
    pinnedId, held, now: realm.now,
    onAdopt: () => { const text = store.export(); if (text) save(text) },
  })
  const ready = await store.ready
  if (!ready.ok) onLog('mesh-bootstrap:realm-held-descriptor-rejected', { reason: ready.reason })
  // The baked descriptor: adopted if nothing usable is held, or if it is a higher serial than the persisted one.
  if (descriptor) await store.offer(descriptor, { linkId: 'baked' })

  const verifier = pkg.createRealmVerifier({
    pinnedId, store, registry, now: realm.now, skew: realm.skew, onEvent: emit,
    limits: { ...(realm.guestTtl !== undefined ? { guestTtl: realm.guestTtl } : {}), ...realm.limits },
  })
  const admission = createLinkAdmission({
    ...realm.admission,
    // A stranger is restricted to the realm exchange, never let in on this node's say-so. A peer the registry already lets link
    // (an operator grant, or a live realm grant) is let in as it is: the wsh authorizer asks the registry first, and a WebRTC
    // link has no such check of its own.
    decide: ({ peerKey }) => (registry.checkAccess(peerKey, LINK_RESOURCE, LINK_ACTION)?.allowed === true ? 'allow' : 'restrict'),
    handler: verifier.handler,
    maxFrameBytes: pkg.MIN_SEAM_FRAME_BYTES,
    onEvent: emit,
  })
  return { pkg, store, verifier, admission, policy, emit, options: realm, registry, onLog }
}

/**
 * @param {object} node the PeerNode (a node of `createMeshNode`)
 * @param {Awaited<ReturnType<typeof prepareRealm>>} prepared
 * @param {{ servicesNetwork?: object }} [ctx]
 */
export function attachRealm(node, prepared, { servicesNetwork } = {}) {
  const { pkg, store, verifier, policy, emit, options, registry, onLog } = prepared
  const pinnedId = options.pinnedId
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const autoRenew = options.autoRenew ? { credentialProvider: options.autoRenew.credentialProvider, beforeSeconds: options.autoRenew.beforeSeconds ?? DEFAULT_BEFORE_SECONDS } : null
  /** The credential this node presents: text, `null` (the open-mode guest role), or `undefined` (none; nothing is presented on its own). */
  let credential = options.credential
  /** What this node presented successfully, per host: { podId, role, notAfter (seconds), via }. */
  const presented = new Map()
  /** Presentations running now, per host. */
  const inflight = new Map()
  const channels = new Set()
  let renewTimer = null
  let closed = false

  const hasLiveGrant = (peer) => registry.listRealmGrants({ realmId: pinnedId, peerKey: peer }).length > 0
  const defaultEndpoints = (podId) => (node.wsh ? { wsh: podId } : { webrtc: podId })
  const originalConnect = node.connectToPeer.bind(node)

  // -- the realm protocol (host side) ------------------------------------------------------
  // Open only to a peer holding a live grant of THIS realm; every other protocol keeps the registry's own `protocol:<name>:open`.
  const authorize = (peer, name, action) => (name === PROTOCOL
    ? action === 'open' && hasLiveGrant(peer)
    : registry.checkAccess(peer, `protocol:${name}`, action))
  let protocols = node.services.get('mesh-protocols')
  let ownService = false
  if (!protocols) {
    protocols = attachService(node, servicesNetwork, createMeshProtocolService({ authorize, onLog: (...a) => onLog(...a) }))
    node.services.set(protocols.name, protocols)
    ownService = true
  }
  protocols.api.serveProtocol(PROTOCOL, (channel) => {
    // The verifier's handler over a link-shaped view of the channel. The link is up already, so `promote` only ends the channel
    // (and reports false: a renewal is not a promotion). The verifier writes the grant before it sends the result.
    const link = {
      peerKey: channel.peer,
      transport: 'protocol',
      proven: true,
      send: (frame) => channel.send(frame),
      onFrame: (cb) => { channel.onMessage((frame) => cb(frame)) },
      onClose: (cb) => { channel.onClose(() => cb('closed')) },
      promote: () => { setImmediate(() => channel.close()); return false },
      close: (reason) => { channel.close(typeof reason === 'string' ? reason : undefined); return true },
    }
    return verifier.handler(link)
  })

  // -- the dialler -------------------------------------------------------------------------
  function record(podId, result, via) {
    if (result.ok) {
      presented.set(podId, { podId, role: result.role ?? null, notAfter: result.notAfter ?? null, via })
      armRenewal()
    } else if (result.reason !== 'peer-does-not-speak-realms' && result.reason !== 'timeout') {
      presented.delete(podId)
    }
    emit({ type: via === 'renew' ? 'renewed' : 'presented', podId, result })
  }

  /** Listeners first, then the connection, then the prover: the host's hello is not lost. */
  function startPresentation(podId, connect, { credential: cred, timeoutMs: ms }) {
    const existing = inflight.get(podId)
    if (existing) return existing
    const channel = nodeChannel(node, podId)
    channels.add(channel)
    const session = Promise.resolve().then(connect)
    session.catch(() => {})
    const result = (async () => {
      try {
        await session
      } catch (err) {
        return { ok: false, reason: 'connect-failed', detail: err?.message || String(err) }
      }
      const r = await pkg.createRealmProver({ pinnedId, store, credential: cred, channel, timeoutMs: ms })
      record(podId, r, 'present')
      return r
    })().finally(() => {
      channel.dispose()
      channels.delete(channel)
      inflight.delete(podId)
    })
    const entry = { session, result }
    inflight.set(podId, entry)
    return entry
  }

  node.connectToPeer = function connectToPeer(podId, endpoints, auth) {
    if (closed || credential === undefined || inflight.has(podId)) return originalConnect(podId, endpoints, auth)
    return startPresentation(podId, () => originalConnect(podId, endpoints, auth), { credential, timeoutMs }).session
  }

  /** Renewals to one peer run one at a time: the `realm` channel is named, so two at once would be one channel. */
  const renewing = new Map()
  function renew(podId, credentialText, opts) {
    if (typeof credentialText !== 'string') return Promise.reject(new TypeError('realm.renew(podId, credentialText): the credential is text'))
    const run = (renewing.get(podId) ?? Promise.resolve()).then(() => renewOnce(podId, credentialText, opts))
    const tail = run.catch(() => {})
    renewing.set(podId, tail)
    tail.then(() => { if (renewing.get(podId) === tail) renewing.delete(podId) })
    return run
  }
  async function renewOnce(podId, credentialText, { timeoutMs: ms = timeoutMs, endpoints, auth } = {}) {
    if (closed) return { ok: false, reason: 'node-shutdown' }
    const via = protocolChannel()
    let channel
    try {
      if (!node.hasActiveSession(podId)) await originalConnect(podId, endpoints ?? defaultEndpoints(podId), auth)
      channel = await protocols.api.openProtocol(podId, PROTOCOL, { timeoutMs: ms, setup: via.capture })
    } catch (err) {
      return { ok: false, reason: err?.reason || 'renew-failed', ...(err?.message ? { detail: err.message } : {}) }
    }
    try {
      const r = await pkg.createRealmProver({ pinnedId, store, credential: credentialText, channel: via, timeoutMs: ms })
      if (r.ok) record(podId, r, 'renew')
      else emit({ type: 'renewed', podId, result: r })
      return r
    } finally {
      // The host ends the channel itself once it has answered. Wait for that notice before this side closes: a protocol channel is
      // named, so a late close notice from the host would otherwise land on the NEXT `realm` channel opened to the same peer.
      let timer
      await Promise.race([
        new Promise((resolve) => { channel.onClose(() => resolve()) }),
        new Promise((resolve) => { timer = setTimeout(resolve, CLOSE_WAIT_MS) }),
      ])
      clearTimeout(timer)
      channel.close()
    }
  }

  // -- auto-renew: one timer for the realm -------------------------------------------------
  function clearTimer() {
    if (renewTimer) clearTimeout(renewTimer)
    renewTimer = null
  }
  function armRenewal(retry = false) {
    if (!autoRenew || closed) return
    clearTimer()
    let soonest = Infinity
    for (const p of presented.values()) if (typeof p.notAfter === 'number') soonest = Math.min(soonest, p.notAfter)
    if (soonest === Infinity) return
    const wait = retry ? RETRY_RENEW_MS : Math.max(MIN_RENEW_DELAY_MS, (soonest - autoRenew.beforeSeconds) * 1000 - Date.now())
    renewTimer = setTimeout(() => { renewTimer = null; renewDue().catch(() => {}) }, Math.min(wait, 2 ** 31 - 1))
    renewTimer.unref?.()
  }
  async function renewDue() {
    if (closed) return
    const due = [...presented.values()].filter((p) => typeof p.notAfter === 'number' && (p.notAfter - autoRenew.beforeSeconds) * 1000 <= Date.now() + MIN_RENEW_DELAY_MS)
    let text = null
    try { text = await autoRenew.credentialProvider() } catch (err) { onLog('mesh-bootstrap:realm-credential-provider-failed', { error: err?.message || String(err) }) }
    if (closed) return
    if (typeof text !== 'string') return armRenewal(true)
    for (const p of due) {
      if (closed) return
      const r = await renew(p.podId, text)
      if (!r.ok) presented.delete(p.podId)
    }
    armRenewal()
  }

  node.on('shutdown', () => {
    closed = true
    clearTimer()
    for (const channel of [...channels]) channel.dispose('node-shutdown')
    if (ownService) protocols.teardown().catch(() => {})
  })

  const api = {
    store,
    verifier,
    policy,
    /** Present this node's credential to `podId` over a fresh link (connects first, with the listener already in place). */
    async present(podId, { credential: cred = credential ?? null, timeoutMs: ms = timeoutMs, endpoints, auth } = {}) {
      if (closed) return { ok: false, reason: 'node-shutdown' }
      return startPresentation(podId, () => originalConnect(podId, endpoints ?? defaultEndpoints(podId), auth), { credential: cred, timeoutMs: ms }).result
    },
    renew,
    /** Set the credential `present()` and the automatic path use (text), `null` for the open-mode guest role, `undefined` for none. */
    setCredential(text) {
      if (text !== undefined && text !== null && typeof text !== 'string') throw new TypeError('realm.setCredential: text, null or undefined')
      credential = text
    },
    status() {
      const d = store.current()
      return {
        realmId: pinnedId,
        holdsDescriptor: d !== null,
        serial: d?.serial ?? 0,
        epoch: d?.epoch ?? 0,
        mode: d?.mode ?? null,
        credential: credential === undefined ? 'none' : credential === null ? 'guest' : 'set',
        peers: [...presented.values()].map((p) => ({ ...p })),
        grants: registry.listRealmGrants({ realmId: pinnedId }).length,
        autoRenewArmed: renewTimer !== null,
      }
    },
  }
  node.realm = api
  return api
}
