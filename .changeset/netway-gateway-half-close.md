---
"@johnhenry/browsermesh-netway": minor
---

`GatewayBackend` follows wsh 0.57's half-close rule. A `GatewayClose` is "no more from me": the application's `end()` sends one and an answer that arrives later is still delivered; the host's `GatewayClose` ends the application's reads but no longer its writes, so what it writes afterwards still reaches the origin. `close()` and `destroy()` send `GatewayClose` with the reason `discarded`, and a `discarded` from the host ends both directions. New option `halfCloseIdleMs` (default 300000, the same as wsh's host; 0 = never) ends a half-closed connection that nothing has moved on in either direction. A connection that is not half-closed is never ended by it.

Consequence for callers: a host that never closes its side when it reads the end of the client's now holds the connection (and its `maxConnections` slot) for up to the bound where it used to be freed about a second later. A host older than wsh 0.57 still ends a connection a second after the client's close; the backend reads that as the host's half-close. Nothing new is sent to an older host (a `GatewayClose` with a reason is read by it as a plain close).
