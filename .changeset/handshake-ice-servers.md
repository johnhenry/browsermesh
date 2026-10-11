---
"@johnhenry/browsermesh-core": minor
---

`HandshakeCoordinator` now forwards ICE configuration to the WebRTC transports it creates (#248). New constructor options `iceServers` and `iceTransportPolicy` are the defaults for `connectToPeer`, `acceptConnection` and `connectViaToken`; per-call values override them (`connectToPeer(id, { iceServers, iceTransportPolicy })`, new third argument `acceptConnection(id, offer, opts)`, new third argument `connectViaToken(token, factory, opts)`; a token's own `iceServers` sit between the per-call value and the default). ICE settings are passed to the transport as `iceServers` / `iceTransportPolicy` (previously only a `config.iceServers` shape the real `WebRTCTransport` ignored, and nothing at all on the answer side), so `iceTransportPolicy: 'relay'` with TURN entries no longer throws. With no ICE configuration, behaviour is unchanged.
