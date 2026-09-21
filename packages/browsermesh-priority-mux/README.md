# browsermesh-priority-mux

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Fbrowsermesh-priority-mux.svg)](https://www.npmjs.com/package/@johnhenry/browsermesh-priority-mux)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Fbrowsermesh-priority-mux.svg)](LICENSE)

Application-level priority scheduling for single-stream transports. A plain
WebSocket is one ordered TCP byte stream with no multi-stream capability at
all -- unlike WebRTC, which gets a second `RTCDataChannel` almost for free
(see `@johnhenry/browsermesh-transport`'s dual-datachannel priority split).
Over a WebSocket, the only way to stop a large bulk send (a file transfer, a
sync delta) from blocking a small urgent message (a control/heartbeat/chat
message) behind it in delivery order is an application-level scheduler that
chunks large messages and interleaves them with small ones by priority.

This package borrows its scheduling *idea* -- prioritizing short messages so
they don't queue behind long ones -- from Homa (Ousterhout et al., Stanford;
a receiver-driven, message-oriented, SRPT-style datacenter RPC transport). It
does not implement Homa's wire protocol, congestion control, or receiver-side
scheduling; it's a much smaller, sender-side, WFQ-with-anti-starvation
scheduler purpose-built for one already-open, ordered, message-boundary-
preserving connection (WebSocket, but really anything shaped the same way).

## Why this exists

`@johnhenry/browsermesh-transport`'s `WebSocketTransport` is the real,
already-integrated WebSocket fallback `TransportFactory.negotiate()` picks
when WebRTC and WebTransport negotiation both fail (`preferredOrder =
['webrtc', 'wsh-wt', 'wsh-ws']`). Once picked, it's a generic transport --
every kind of traffic a WebRTC data channel would have carried (chat, file
transfer, sync, consensus/control messages) gets tagged and multiplexed onto
that one WebSocket, with a raw `ws.send()` per message and no chunking or
priority separation at all. A large sync payload sent right before a small
urgent chat message will delay that chat message until the sync payload's
bytes clear the socket.

## Design

### Transport-agnostic adapter

`PriorityMux` wraps anything shaped like:

```js
{ send(bytes), on(event, cb), close?() } // events: 'open' | 'message' | 'close' | 'error'
```

This is the same shape `@johnhenry/browsermesh-transport`'s
`WebSocketTransport`/`WebRTCTransport`/`WebTransportTransport` already
expose, so a mux instance is a drop-in wrapper: anywhere code did
`transport.send(x)` / `transport.on('message', cb)`, it can do `mux.send(x)`
/ `mux.on('message', cb)` instead, unchanged. The core scheduler has no
WebSocket-specific code in it.

### Wire framing

Each chunk is one frame, one `adapter.send()` call. Mirrors the binary
framing style already used in this monorepo
(`browsermesh-transport/src/wisp-client.mjs`'s `encodeFrame`/`decodeFrame`:
fixed-size header via `DataView`, little-endian) rather than
`JSON.stringify`-ing an object per chunk:

```
[version:u8][priority:u8][msgId:u32][seq:u32][total:u32][payload:...]
 byte 0       byte 1        bytes 2-5  bytes 6-9  bytes 10-13  bytes 14+
```

Messages are transparently wrapped in a 1-byte envelope tag before chunking
(raw bytes / UTF-8 string / JSON value) so reassembly hands back the same
shape that was sent -- callers don't need to know chunking happened at all.

### Priority queues + anti-starvation

Three tiers by default (`'high' | 'normal' | 'low'`, configurable). Draining
picks the highest non-empty tier -- *except* every Nth drain slot
(`starvationGuardInterval`, default 8), which is reserved unconditionally for
the lowest non-empty tier, regardless of how much higher-tier backlog is
queued. That gives a concrete bound: a message sitting alone in the lowest
tier is dequeued within `starvationGuardInterval` drain slots, even under a
continuous flood of higher-priority sends. See `src/scheduler.mjs`.

### Reassembly

Chunks are buffered by `msgId` (indexed by `seq`, not append order) until
`total` distinct sequence numbers have arrived, then concatenated in order
and delivered as one `'message'` event -- transparent to whatever already
consumes `transport.on('message', ...)`. A message is never delivered
partially. Closing the underlying adapter mid-flight discards all pending
reassembly state so nothing hangs waiting for chunks that will never arrive.

### Priority inference

```js
new PriorityMux(adapter, {
  priorityOf: (data) => {
    if (data?.type === 'ping' || data?.type === 'consensus') return 'high';
    if (data?.type === 'file-chunk') return 'low';
    // return undefined/null to fall through to defaultPriority
  },
});
```

The classifier is entirely caller-supplied -- this package has no built-in
knowledge of any particular ecosystem's message-type names.

## Install

```bash
npm install @johnhenry/browsermesh-priority-mux
```

## Quick start

```js
import { PriorityMux } from '@johnhenry/browsermesh-priority-mux';
import { WebSocketTransport } from '@johnhenry/browsermesh-transport';

const transport = new WebSocketTransport({ url: 'wss://example.com' });
await transport.connect();

const mux = new PriorityMux(transport, { chunkSize: 16 * 1024 });

mux.on('message', (data, meta) => {
  console.log('received', meta.priority, data);
});

// A big sync payload...
mux.send(bigSyncDelta, { priority: 'low' });
// ...won't delay this urgent ping, even though it was queued first.
mux.send({ type: 'ping' }, { priority: 'high' });
```

## API

- `new PriorityMux(adapter, opts)` -- `opts`: `chunkSize` (default 16384),
  `tiers` (default `['high','normal','low']`), `starvationGuardInterval`
  (default 8), `priorityOf(data)`, `defaultPriority` (default `'normal'`),
  `scheduleFn` (injectable drain scheduler, default `setImmediate`).
  - `.send(data, { priority })` -> `{ msgId, total, priority }`
  - `.on(event, cb)` -- `'open' | 'message' | 'close' | 'error'`
  - `.close()`
  - `.getStats()`
- `PriorityScheduler`, `Reassembler` -- the two pieces `PriorityMux` composes,
  usable standalone.
- `encodeChunkFrame`/`decodeChunkFrame`/`splitIntoChunks` -- wire framing.
- `encodeEnvelope`/`decodeEnvelope` -- the transparent type-preserving
  message envelope.

## License

MIT
