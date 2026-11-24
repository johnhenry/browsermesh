---
'@johnhenry/browsermesh-apps': minor
'@johnhenry/browsermesh-transport': patch
'@johnhenry/browsermesh-pod': patch
---

Identifiers that match a response to a request, or name a connection, are now 128 random bits from `crypto.getRandomValues` (apps: mesh-rpc, the routing proxy, orchestrator, compute, agent swarm, verification, timestamp witnesses, swarm join and submit, escrow, chunk replication, torrent, mesh-websocket and mesh-relay connections; transport: stream ids; pod: hosted-pod request ids). There is no `Math.random` or clock-and-counter fallback any more: where the platform has no CSPRNG, creating the id throws an error that says so. The modules that patched `crypto.randomUUID` with a `Math.random` version when it was missing no longer do. Escrow contract and dispute ids are random as well.

Every response is matched on the peer as well as the id: orchestrator, compute, agent swarm, verification, escrow, swarm join and submit, chunk fetch and "have" answers, timestamp witnesses (a peer that was not asked is not counted) and mesh-websocket sessions (an envelope for a connection id is taken only from the peer at the other end). mesh-rpc, the routing proxy, torrent pieces and manifests, files and terminal already did.

No wire change: the id is an opaque string to the peer that echoes it. A peer on an older release answers with whatever id it was sent. Ids are no longer of the form `<podId>:<time>:<counter>`; anything that parsed them should not.
