---
"@johnhenry/browsermesh-pod": minor
---

Add `WebSocketTransport` (issue #185, work package 1): a `TransportAdapter` that speaks the `browsermesh-servers` relay/signaling wire protocol, so a `Pod` can run outside a browser tab — in a plain Node process, a V8 isolate, or a microVM — and still join the mesh. Same injectable-constructor pattern as `BroadcastChannelTransport`'s `BCConstructor` (`opts.WebSocket`, default `globalThis.WebSocket`).

- `send(msg)` relays point-to-point (`{type:'relay', target, envelope}`) when `msg.to` names a specific peer, and fans a `to`-less or `to:'*'` message (discovery's `hello`/`goodbye`) out point-to-point to every peer in `knownPeers`, since the relay server has no broadcast primitive.
- `knownPeers` is seeded from relayed senders seen so far, plus — when `peersFromSignaling: true` and `signalingUrl` is set — a second connection to the signaling server that consumes `peers`/`peer-joined`/`peer-left`.
- Exponential-backoff reconnect with re-registration (`reconnect: {baseMs, maxMs, maxAttempts}`); `ready` is false while disconnected; responds to `ping` with `pong`; `close()` clears all timers.
- Exported from the package root and typed in `index.d.ts`.

**Protocol gap found while implementing this against the real servers**: the design sketch in issue #185 describes the relay protocol using `to`/`from` fields, but `browsermesh-servers/relay/index.mjs` and `signaling/index.mjs` actually use `target`/`source` for `relay`/`signal` and their replies. `WebSocketTransport` speaks the servers' real field names (`target`/`source`) and remaps to the Pod message shape (`from`) only on the way in, so it interoperates with the servers as they exist on `main` today. The issue's protocol description should be corrected to match.
