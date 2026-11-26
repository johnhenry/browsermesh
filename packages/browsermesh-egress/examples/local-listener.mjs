/**
 * A local TCP port whose connections go through a peer (`@johnhenry/browsermesh-egress`).
 *
 * The shape a container engine, a database client or any program that only knows how to open a local socket needs: the program
 * connects to 127.0.0.1:PORT, and every connection is carried by `connectEgress` to one destination a provider's operator has
 * granted to this pod. Bytes move both ways with half-close, and a connection that is not being read stops the other end (a
 * paused local socket pauses the destination); nothing is buffered without bound.
 *
 *   import { listenThroughEgress } from './local-listener.mjs'
 *   const listener = await listenThroughEgress(link, { target: { host: 'db.internal.example', port: 5432 } })
 *   // point the program at 127.0.0.1:${listener.port}
 *
 * Run it with no arguments for a self-contained demonstration (what `npm run examples` does): a provider, a consumer and a
 * stand-in destination on one in-process bus, reading `local-listener.grants.json` as the provider's command would.
 *
 * Run it for real, in three steps:
 *
 *   1. Ask the consumer for its pod id (a new identity is kept in --identity, mode 0600, so the id does not change):
 *        node local-listener.mjs --print-pod-id --identity ./consumer.json
 *   2. Put that id in a copy of local-listener.grants.json, and start a provider on the machine whose network is lent:
 *        browsermesh-egress --config ./grants.json --signaling wss://signal.example/signaling --identity ./egress-identity.json
 *      (add --dry-run first to read the grants as sentences; the command prints its own pod id)
 *   3. Start the local port; point the program at it:
 *        node local-listener.mjs --provider <the provider's pod id> --signaling wss://signal.example/signaling \
 *          --identity ./consumer.json --target db.internal.example:5432 --listen 127.0.0.1:5432
 *
 * Real mode needs the optional dependency `node-datachannel` (WebRTC for Node). The listener binds to loopback only: the grant is
 * this pod's, not whoever can reach the port, so a local port that anyone on a network could use would lend the grant to them.
 */
import assert from 'node:assert/strict'
import net from 'node:net'
import { readFile, writeFile, chmod } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { connectEgress } from '@johnhenry/browsermesh-egress'

const isLoopback = (host) => host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)

/**
 * Listen on a loopback port and carry each connection to `target` through `link`.
 *
 * @param {object} link - what `connectEgress(...)` (or `egress.connect(...)` from `./browser`) returned
 * @param {object} opts
 * @param {{ host: string, port: number }} opts.target - the destination; the provider's operator must have granted it to this pod
 * @param {string} [opts.host='127.0.0.1'] - loopback only
 * @param {number} [opts.port=0] - 0 picks a free port
 * @param {number} [opts.maxConnections=32] - at once (the link's own default limit); another is closed at once, not queued
 * @param {(error: Error) => void} [opts.onError] - a connection that could not be made or ended badly (`error.code`: `no-grant`, `too-many-connections`, ...)
 * @param {(info: { reason: string }) => void} [opts.onLinkClosed] - the link to the provider ended; every local connection was closed with it
 * @returns {Promise<{ host: string, port: number, stats(): { open: number, total: number }, close(): Promise<void> }>}
 */
export async function listenThroughEgress(link, { target, host = '127.0.0.1', port = 0, maxConnections = 32, onError, onLinkClosed } = {}) {
  if (!target || typeof target.host !== 'string' || !target.host || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
    throw new TypeError('listenThroughEgress: target is { host, port }, a host name or address and a port from 1 to 65535')
  }
  if (!isLoopback(host)) throw new TypeError(`listenThroughEgress: ${host} is not a loopback address; this listener lends the pod's grant to whoever connects`)
  const report = (e) => { try { onError?.(e) } catch { /* the owner's hook never breaks a connection */ } }
  const locals = new Set()
  let total = 0

  // A connection that is turned away is finished politely: our end is closed, what the program is still sending is read and
  // dropped, and the socket goes when the program closes its end (or after a few seconds). Destroying it at once could reset a
  // connection whose first bytes are still arriving, and the program would see a reset instead of a closed connection.
  const turnAway = (local) => { local.setTimeout(5000, () => local.destroy()); local.resume(); local.end() }

  const server = net.createServer({ allowHalfOpen: true, pauseOnConnect: true }, (local) => {
    local.on('error', () => {}) // the 'close' that follows is what is acted on
    if (locals.size >= maxConnections) {
      report(Object.assign(new Error(`more than ${maxConnections} connections at once`), { code: 'too-many-connections' }))
      turnAway(local)
      return
    }
    locals.add(local)
    local.on('close', () => locals.delete(local))
    total += 1
    link.connect(target.host, target.port).then((remote) => {
      if (local.destroyed) { remote.destroy?.(); return }
      bridge(local, remote, report)
    }, (e) => { report(e); turnAway(local) })
  })

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve() }) })
  const unlisten = link.onClose?.((info) => {

    for (const local of [...locals]) local.destroy()
    try { onLinkClosed?.(info) } catch { /* the owner's hook never breaks the listener */ }
  })

  return {
    host,
    port: server.address().port,
    stats: () => ({ open: locals.size, total }),
    close() {
      unlisten?.()
      for (const local of [...locals]) local.destroy()
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

/** Move bytes both ways between one local socket and one remote socket, with half-close and backpressure, until either side is gone. */
function bridge(local, remote, report) {
  let finished = false
  const finish = () => { if (finished) return; finished = true; local.destroy(); try { remote.destroy?.() } catch { /* already gone */ } }
  local.on('close', finish)

  // local -> remote: one chunk at a time; the local socket is paused until the link has taken it
  local.on('data', (chunk) => {
    local.pause()
    remote.write(chunk).then(() => { if (!finished) local.resume() }, (e) => { report(e); finish() })
  })
  local.on('end', () => { remote.end().catch(() => {}) }) // the local side is done sending; the destination can still answer

  // remote -> local: wait for the local socket to drain before asking the link for more
  const drained = () => new Promise((resolve) => {
    const done = () => { local.off('drain', done); local.off('close', done); resolve() }
    local.on('drain', done)
    local.on('close', done)
  })
  ;(async () => {
    try {
      for (;;) {
        const chunk = await remote.read()
        if (chunk === null || finished) break
        if (!local.write(chunk)) await drained()
      }
      if (!finished) local.end()
    } catch (e) { report(e); finish() }
  })()
  local.resume()
}

// ── running it ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument "${arg}"`)
    const name = arg.slice(2)
    if (name === 'print-pod-id') { out[name] = true; continue }
    const value = argv[++i]
    if (value === undefined) throw new Error(`--${name} needs a value`)
    out[name] = value
  }
  return out
}

const hostPort = (text, what, { minPort = 1 } = {}) => {
  const m = /^(\[[0-9a-f:.]+\]|[^:\s]+):(\d{1,5})$/i.exec(text ?? '')
  if (!m || Number(m[2]) < minPort || Number(m[2]) > 65535) throw new Error(`${what} is HOST:PORT`)
  return { host: m[1].replace(/^\[|\]$/g, ''), port: Number(m[2]) }
}

/** Real mode: a consumer node on a signalling server, a link to the provider, and the local port. */
async function runForReal(args) {
  let ndc
  try { ndc = await import('node-datachannel/polyfill') } catch { throw new Error('WebRTC is not available in Node: install the optional dependency node-datachannel (npm install node-datachannel)') }
  Object.assign(globalThis, { RTCPeerConnection: ndc.RTCPeerConnection, RTCIceCandidate: ndc.RTCIceCandidate, RTCSessionDescription: ndc.RTCSessionDescription })
  const { createEgressNode } = await import('@johnhenry/browsermesh-egress/browser')

  let identity
  if (args.identity) {
    try { identity = JSON.parse(await readFile(args.identity, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw new Error(`cannot read ${args.identity}: ${e.message}`) }
  }
  if (!args.signaling) throw new Error('--signaling URL is required')
  const egress = await createEgressNode({ signaling: args.signaling, identity })
  if (args.identity && !identity) {
    await writeFile(args.identity, `${JSON.stringify({ privateKeyJwk: await egress.identityManager.export(egress.podId) })}\n`, { mode: 0o600 })
    await chmod(args.identity, 0o600)
  }
  if (args['print-pod-id']) {
    console.log(egress.podId)
    await egress.close()
    return
  }
  console.log(`this pod id (the one the provider's grants name): ${egress.podId}`)
  const target = hostPort(args.target, '--target')
  const listen = hostPort(args.listen ?? '127.0.0.1:0', '--listen', { minPort: 0 }) // port 0: a free one
  if (!args.provider) throw new Error('--provider PODID is required (the pod id the egress command printed)')
  const link = await egress.connect(args.provider)
  const listener = await listenThroughEgress(link, {
    target, host: listen.host, port: listen.port,
    onError: (e) => console.error(`a connection failed: ${e.code ?? e.message}`),
    onLinkClosed: ({ reason }) => { console.error(`the link to the provider ended (${reason})`); process.exit(1) },
  })
  console.log(`listening on ${listener.host}:${listener.port} -> ${target.host}:${target.port}, through ${link.peer}`)
  const stop = async () => { await listener.close(); await link.close(); await egress.close(); process.exit(0) }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

/** Demo mode: everything in this process, on a simulated bus. */
async function runDemo() {
  const { PodIdentity } = await import('@johnhenry/browsermesh-primitives')
  const { MeshPeerManager, TrustGraph, MeshACL } = await import('@johnhenry/browsermesh-core')
  const { attachService, createMeshProtocolService, PeerRegistry, protocolScope } = await import('@johnhenry/browsermesh-apps')
  const { createMeshEgress } = await import('@johnhenry/browsermesh-egress')
  const { nodeDialer } = await import('@johnhenry/browsermesh-egress/node')

  // two pods on a simulated bus
  const nodes = new Map()
  const makeNode = async () => {
    const { podId } = await PodIdentity.generate()
    const listeners = new Set()
    const node = {
      podId,
      listeners,
      onIncomingData(cb) { listeners.add(cb); return () => listeners.delete(cb) },
      async sendTo(to, data) {
        const target = nodes.get(to)
        if (!target) throw new Error('unreachable peer')
        const text = JSON.stringify(data) // a real transport carries JSON text
        queueMicrotask(() => { for (const cb of target.listeners) cb(podId, text) })
      },
    }
    node.registry = new PeerRegistry({ localPodId: podId, peerManager: new MeshPeerManager({}), trustGraph: new TrustGraph(), acl: new MeshACL({ owner: podId }) })
    nodes.set(podId, node)
    return node
  }
  const consumerNode = await makeNode()
  const providerNode = await makeNode()
  const consumerSvc = attachService(consumerNode, undefined, createMeshProtocolService())
  const providerSvc = attachService(providerNode, undefined, createMeshProtocolService())

  // the destination: a stand-in for db.internal.example:5432, answering every byte with the same byte
  const origin = net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.on('data', (d) => socket.write(d))
    socket.on('end', () => socket.end())
    socket.on('error', () => {})
  })
  await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve))
  const originPort = origin.address().port

  // the provider, granting what the grants file says (the command does the same with the same file, for a peer's real pod id)
  const grants = JSON.parse(await readFile(fileURLToPath(new URL('./local-listener.grants.json', import.meta.url)), 'utf8'))
  const dialer = nodeDialer({ lookup: async (name) => { if (name === 'db.internal.example') return ['127.0.0.1']; throw Object.assign(new Error('no such name'), { code: 'ENOTFOUND' }) }, allowPrivate: ['127.0.0.1/32'] })
  const egress = createMeshEgress({
    service: providerSvc,
    registry: providerNode.registry,
    ...dialer,
    // the destination is named db.internal.example:5432 everywhere a grant is read; only the last hop goes to the stand-in
    dial: (request) => dialer.dial({ ...request, port: request.port === 5432 ? originPort : request.port }),
    unattended: true,
  })
  egress.start()
  for (const g of grants.grants) providerNode.registry.grantCapabilities(consumerNode.podId, [protocolScope('egress'), ...g.scopes])

  // the consumer: one link, one local port
  const link = await connectEgress(consumerSvc, providerNode.podId)
  const refusals = []
  const listener = await listenThroughEgress(link, { target: { host: 'db.internal.example', port: 5432 }, onError: (e) => refusals.push(e) })
  console.log(`listening on ${listener.host}:${listener.port} -> db.internal.example:5432`)

  const ask = (port, text) => new Promise((resolve, reject) => {
    const parts = []
    const socket = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true }, () => socket.end(text))
    socket.on('data', (d) => parts.push(d))
    socket.on('end', () => resolve(Buffer.concat(parts).toString()))
    socket.on('error', reject)
  })
  const echoed = await ask(listener.port, 'hello from a local client')
  assert.equal(echoed, 'hello from a local client')
  console.log('echoed through the provider:', echoed)

  // the same port, a second destination: not granted, so the provider never dials it
  const other = await listenThroughEgress(link, { target: { host: 'db.internal.example', port: 5433 }, onError: (e) => refusals.push(e) })
  assert.equal(await ask(other.port, 'nobody granted this'), '')
  await new Promise((resolve) => { const t = setInterval(() => { if (refusals.length) { clearInterval(t); resolve() } }, 5) })
  assert.equal(refusals[0].code, 'no-grant')
  console.log(`a destination with no grant: the local connection was closed (${refusals[0].code})`)

  await other.close()
  await listener.close()
  await link.close()
  await egress.stop()
  await new Promise((resolve) => origin.close(resolve))
  consumerSvc.teardown()
  providerSvc.teardown()
  console.log('done')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2))
  try {
    if (args.provider || args['print-pod-id']) await runForReal(args)
    else await runDemo()
  } catch (e) {
    console.error(`local-listener: ${e.message}`)
    process.exit(1)
  }
}
