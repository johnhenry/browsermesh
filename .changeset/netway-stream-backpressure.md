---
"@johnhenry/browsermesh-netway": minor
---

`StreamSocket` now has byte-level backpressure. Each direction has a receive window (`createPair({ windowBytes })`, default 256 KiB): `write()` resolves only once the peer's window has taken every byte, reading returns credit, and the data held on each side is bounded (`readableLength` / `writableLength` report it). New: `end()` (half-close), `destroy(err)`, `windowBytes` / `peerWindowBytes`, and `readable` / `writable` Web Streams views. A peer with no window (`windowBytes: 0`, or a buffer from before windows) is served as before; `GatewayBackend` does not window data arriving from the wire.

Behaviour changes for existing callers: a `write()` to a reader that does not read now stays pending once the window is full (before, it returned at once and the socket closed after 1,024 queued chunks); and `close()` now lets the peer read what it had already been given before it sees EOF (before, the peer's unread data was discarded). Code that wrote more than the window before reading must read concurrently, or pass `windowBytes: 0` for the old behaviour. Also, a write larger than the window now reaches the reader in window-sized pieces: code that treats one `read()` as one message (for example a JSON request over a socket) must reassemble across reads, or pass `windowBytes: 0`.
