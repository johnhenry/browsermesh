---
"@johnhenry/browsermesh-apps": minor
"@johnhenry/browsermesh-transport": minor
---

Wire the sealed wsh peer link through the peer layer (#273).

- `createMeshNode({ wsh: { relays, ... } })` opts a node in (off unless given). The node's own identity is the wsh identity, a peer may link to it only if the registry grants `mesh:link:connect` (override with `wsh.authorize`), and `node.connectToPeer(podId, { wsh: podId })` reaches a peer. The listening side's inbound link is adopted as a `PeerNode` session under the pod id derived from the key wsh authenticated, so `fromPubKey` is that key and mesh-rpc, mesh-sync, mesh-relay and every other service run over it unchanged. `wsh.require: true` makes wsh the only transport `connectToPeer()` uses; a failed wsh link is then a failed connect.
- New exports: `createWshAuthorizer(registry)`, `createWshAdapterFactory(links)`, `attachWshLinks({ node, links, negotiator })`, `WSH_LINK_RESOURCE`, `WSH_LINK_ACTION`.
- `PeerNode.connectToPeer()` rethrows a negotiation failure when its negotiator was told to require a transport (`MeshTransportNegotiator` `require`), instead of falling through to a session with no transport. Without `require` nothing changes.
- `MeshTransportNegotiator` gains a `required` getter (the transport type it was told to require, or `null`); `createHardenedNegotiator()` forwards it.
