// A child process for the real-peer tests: one end of an egress link (a provider or a consumer) in its own process, so the test can
// kill it outright (SIGKILL: no close frame, no goodbye) and time how long the other end takes to notice.
//
// The signalling between the two processes is the IPC channel: every message the node sends goes to the parent as { signal }, and
// every { signal } from the parent is what the node receives. The data channel itself is a real WebRTC one (node-datachannel).
//
//   node peer-child.mjs provider            the parent sends { grant: podId, originPort } and reads { podId }, { ready }, { stats }
//   node peer-child.mjs consumer            the parent sends { connect: providerPodId, originPort } and reads { podId }, { connected }
const role = process.argv[2]
const ndc = await import('node-datachannel/polyfill')
Object.assign(globalThis, { RTCPeerConnection: ndc.RTCPeerConnection, RTCIceCandidate: ndc.RTCIceCandidate, RTCSessionDescription: ndc.RTCSessionDescription })
if (!globalThis.crypto) globalThis.crypto = {}
if (!crypto.randomUUID) crypto.randomUUID = () => `uuid-${Math.random().toString(36).slice(2)}`

let handler = null
const signalingTransport = {
  send: (message) => { process.send({ signal: message }) },
  onMessage: (cb) => { handler = cb },
}
const commands = []
let wake = null
process.on('message', (m) => {
  if (m?.signal) handler?.(m.signal)
  else { commands.push(m); wake?.() }
})
const next = async () => { while (!commands.length) await new Promise((r) => { wake = r }); return commands.shift() }

const egress = await import('../../../src/index.mjs')
const nodeEntry = await import('../../../src/node.mjs')

if (role === 'provider') {
  const apps = await import('@johnhenry/browsermesh-apps')
  const { ManualStrategy } = await import('@johnhenry/browsermesh-discovery')
  const node = await apps.createMeshNode({ label: 'provider', discoveryStrategies: [new ManualStrategy()], skipDiscovery: true, signalingTransport, iceServers: [] })
  const svc = apps.attachService(node, undefined, apps.createMeshProtocolService())
  const lookup = async (name) => { if (name === 'origin.test') return ['127.0.0.1']; const e = new Error('nx'); e.code = 'ENOTFOUND'; throw e }
  const provider = egress.createMeshEgress({ service: svc, registry: node.registry, ...nodeEntry.nodeDialer({ lookup, allowPrivate: ['127.0.0.1/32'] }), unattended: true })
  provider.start()
  process.send({ podId: node.podId })
  const { grant, originPort } = await next()
  node.registry.grantCapabilities(grant, [apps.protocolScope('egress'), `egress:tcp:origin.test:${originPort}:connect`, 'egress:dns:origin.test:resolve'])
  process.send({ ready: true })
  for (;;) { await next(); process.send({ stats: provider.stats() }) }
} else if (role === 'consumer') {
  const { createEgressNode } = await import('../../../src/browser.mjs')
  const egressNode = await createEgressNode({ signaling: signalingTransport, iceServers: [] })
  process.send({ podId: egressNode.podId })
  const { connect, originPort } = await next()
  const link = await egressNode.connect(connect)
  const socket = await link.connect('origin.test', originPort)
  await socket.write(new TextEncoder().encode('ping'))
  await socket.read()
  process.send({ connected: true })
  await new Promise(() => {})
} else {
  throw new Error(`peer-child: role is provider or consumer, not ${role}`)
}
