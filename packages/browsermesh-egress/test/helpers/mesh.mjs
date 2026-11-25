/**
 * Test helpers: pods on a simulated in-process bus, each with its own PeerRegistry (default deny) and a protocol
 * service; local TCP origins; and a simulated network behind the provider's `dial` and `resolve` seam.
 *
 * Nothing here contacts a host outside this machine. "Public" addresses are names in a table: the real wsh address guard
 * classifies them, and the connection goes to a local listener the test started.
 */
import net from 'node:net'
import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import { MeshPeerManager, TrustGraph, MeshACL } from '@johnhenry/browsermesh-core'
import { attachService, createMeshProtocolService, PeerRegistry } from '@johnhenry/browsermesh-apps'
import { AddressGuardError, resolveChecked } from '@johnhenry/wsh/address-guard'

export async function createNodes(count) {
  const nodes = new Map()
  for (let i = 0; i < count; i++) {
    const { podId } = await PodIdentity.generate()
    const listeners = new Set()
    const node = {
      podId,
      listeners,
      onIncomingData(cb) { listeners.add(cb); return () => listeners.delete(cb) },
      async sendTo(to, data) {
        const target = nodes.get(to)
        if (!target) throw new Error('unreachable peer')
        const text = JSON.stringify(data)
        queueMicrotask(() => { for (const cb of target.listeners) cb(podId, text) })
      },
    }
    node.registry = new PeerRegistry({ localPodId: podId, peerManager: new MeshPeerManager({}), trustGraph: new TrustGraph(), acl: new MeshACL({ owner: podId }) })
    nodes.set(podId, node)
  }
  return [...nodes.values()]
}

/** A consumer pod, a provider pod, and a stranger, each with a protocol service. `channelOptions` are the mesh channel's limits. */
export async function threePods({ channelOptions } = {}) {
  const [consumer, provider, stranger] = await createNodes(3)
  const svc = (node) => attachService(node, undefined, createMeshProtocolService(channelOptions))
  const c = svc(consumer)
  const p = svc(provider)
  const s = svc(stranger)
  return { consumer, provider, stranger, c, p, s, teardown() { c.teardown(); p.teardown(); s.teardown() } }
}

export const OPEN = 'protocol:egress:open'

/** The provider grants the consumer the protocol and these scopes. */
export const grant = (pods, scopes = []) => pods.provider.registry.grantCapabilities(pods.consumer.podId, [OPEN, ...scopes])
export const revoke = (pods, scopes) => pods.provider.registry.revokeCapabilities(pods.consumer.podId, scopes)

export function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  promise.catch(() => {})
  return { promise, resolve, reject }
}

/** Wait until `fn()` is truthy by yielding to the event loop (no wall-clock assertion depends on it). */
export async function until(fn, what = 'condition') {
  for (let i = 0; i < 5000; i++) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 2))
  }
  throw new Error(`gave up waiting for ${what}`)
}

/** A local TCP listener. `onConnection(socket)` runs for each connection; `close()` ends them all. */
export async function startOrigin(onConnection) {
  const sockets = new Set()
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    onConnection?.(socket)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    sockets,
    close() { for (const s of sockets) s.destroy(); return new Promise((resolve) => server.close(() => resolve())) },
  }
}

/** An origin that echoes whatever it is sent, and ends when the sender half-closes. */
export const echoOrigin = () => startOrigin((socket) => { socket.on('data', (d) => socket.write(d)); socket.on('end', () => socket.end()) })

/**
 * A simulated network for the provider's seam.
 *   names:   name -> answer(s) the resolver gives. An array of arrays answers differently on each lookup (a resolver whose answer changes).
 *   origins: `address:port` -> the local port a connection to that (simulated) address really goes to.
 * `dial` and `resolve` use wsh's real address guard on the simulated answers, and connect to a local origin, never to the address.
 */
export function simNetwork({ names = {}, origins = {}, allowPrivate = [], refuseMixed = true } = {}) {
  const calls = { lookups: [], dials: [], resolves: [] }
  const counts = new Map()
  const lookup = async (name) => {
    calls.lookups.push(name)
    const entry = names[name]
    if (!entry) { const e = new Error('not found'); e.code = 'ENOTFOUND'; throw e }
    if (Array.isArray(entry[0])) { const n = counts.get(name) ?? 0; counts.set(name, n + 1); return entry[Math.min(n, entry.length - 1)] }
    return entry
  }
  const policy = (wide) => ({ allow: wide ? [] : allowPrivate, allowPrivate: false, refuseMixed, lookup })
  return {
    calls,
    async dial({ host, port, wide = false, signal }) {
      calls.dials.push({ host, port, wide })
      const [chosen] = await resolveChecked(host, { ...policy(wide), family: 4, signal })
      const local = origins[`${chosen.address}:${port}`]
      if (!local) throw new AddressGuardError('CONNECTION_REFUSED', 'nothing listens there')
      const socket = net.connect({ host: '127.0.0.1', port: local, allowHalfOpen: true })
      await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
      return { socket, address: chosen.address, family: chosen.family, class: chosen.class }
    },
    async resolve({ name, wide = false, signal }) {
      calls.resolves.push({ name, wide })
      return resolveChecked(name, { ...policy(wide), family: 4, signal })
    },
  }
}

/** Collect a socket's chunks until EOF. Fails the test if the end does not come in 8 s. */
export async function readAll(socket, ms = 8000) {
  let timer
  const never = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the socket did not end')), ms) })
  const all = (async () => {
    const parts = []
    for (;;) {
      const chunk = await socket.read()
      if (chunk === null) break
      parts.push(chunk)
    }
    return Buffer.concat(parts)
  })()
  try { return await Promise.race([all, never]) } finally { clearTimeout(timer) }
}

export const text = (buf) => Buffer.from(buf).toString('utf8')
export const bytes = (s) => new TextEncoder().encode(s)

/** The same pseudo-random byte at every index, so a receiver can check every byte without holding the source. */
export const patternByte = (i) => ((i * 2654435761) >>> 24) & 0xff
export function patternChunk(start, length) {
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) out[i] = patternByte(start + i)
  return out
}

export const PUBLIC = '93.184.216.34'

/**
 * Three pods, an echo origin, a simulated network that maps `pkg.test:443` (at the simulated public address) to it, a started
 * provider with audit and meter sinks, and (unless `link: false`) a consumer link. `cleanups` runs after each test.
 */
export async function rig(cleanups, { names, origins, sets, grants = [], egress = {}, link = {}, simOptions = {}, origin } = {}) {
  const { connectEgress, createMeshEgress } = await import('../../src/index.mjs')
  const pods = await threePods()
  cleanups.push(() => pods.teardown())
  const local = origin ?? await echoOrigin()
  cleanups.push(() => local.close())
  const net = simNetwork({ names: names ?? { 'pkg.test': [PUBLIC] }, origins: origins ?? { [`${PUBLIC}:443`]: local.port }, ...simOptions })
  const audit = []
  const meter = []
  const provider = createMeshEgress({
    service: pods.p, registry: pods.provider.registry, dial: net.dial, resolve: net.resolve, sets, unattended: true,
    onAudit: (r) => audit.push(r), onMeter: (r) => meter.push(r), ...(typeof egress === 'function' ? egress(pods) : egress),
  })
  provider.start()
  cleanups.push(() => provider.stop())
  grant(pods, grants)
  const out = { pods, origin: local, net, provider, audit, meter }
  if (link !== false) {
    out.link = await connectEgress(pods.c, pods.provider.podId, link)
    cleanups.push(() => out.link.close())
  }
  return out
}

/** The consumer's side of the protocol channel with no link on top of it: what a hostile consumer holds. */
export async function rawChannel(pods, { versions = [1] } = {}) {
  const channel = await pods.c.api.openProtocol(pods.provider.podId, 'egress', { versions })
  return channel
}

/** Drain a socket's reads until it fails or ends; resolves to the error, or null at a clean end. Fails the test if neither happens in 8 s. */
export async function outcome(socket, ms = 8000) {
  let timer
  const never = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the socket neither ended nor failed')), ms) })
  const drained = (async () => { try { for (;;) { if ((await socket.read()) === null) return null } } catch (e) { return e } })()
  try { return await Promise.race([drained, never]) } finally { clearTimeout(timer) }
}
