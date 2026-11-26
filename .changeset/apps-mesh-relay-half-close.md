---
"@johnhenry/browsermesh-apps": minor
---

The mesh relay (`MeshRelayHost`, `createMeshRelayBackend`) passes a half-close through. A client that has finished sending (`socket.end()`) still gets the answer the service sends later, and a service that finishes first still receives what the client sends after it; an end of stream used to be a full close in both directions. A new `end` frame ("no more from me") carries it, negotiated: `connect` and `ok` carry `halfClose: true` and only a connection where both sides said so uses `end`. An older peer is never sent one and keeps the full close: an older host answers `ok` without `halfClose`, and an older client's `connect` has none. An application that closes or destroys its socket still closes the connection in full.

New option `halfCloseIdleMs` (host and client; default 300000, matching wsh's; 0 = never): a connection that is half-closed and has had nothing moving in either direction for that long is closed with the reason `idle timeout`, and its `maxConnectionsPerPeer` slot is free again. Between two current peers, a service that never closes its side when it reads the client's end of stream now keeps the connection for up to that bound where it used to be closed at once.
