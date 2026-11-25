---
'@johnhenry/browsermesh-apps': minor
---

The WebRTC negotiator now bounds inbound connections that are still connecting: at most `maxHalfOpenInbound` (default
64) answered-but-not-yet-open connections at once, each closed after `halfOpenTimeoutMs` (default 60 s) if it has not
opened. A further offer closes the oldest unfinished connection to make room; a renegotiation offer for an open
connection takes no slot. `Infinity` turns either bound off, and `createWebRTCTransportFactory(...).halfOpenInbound`
reports the live numbers. Nothing on the wire changes, so an older peer is unaffected. An inbound offer whose answer
fails now also closes its half-built connection instead of leaving it in the manager.
