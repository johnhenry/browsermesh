# wsh over a mesh link

Item 7 of [#334](https://github.com/johnhenry/browsermesh/issues/334): a pod serves, or dials, a wsh session over a
channel between two pods instead of over a relay. Built on wsh 0.50's `@johnhenry/wsh/duplex` (`createDuplexSocket`,
`serveWshOverDuplex`, `connectWshOverDuplex`) and its design note `spec/duplex-binding.md`, which this page does not repeat.

## The owner's question (part b is not built)

**Should a pod be able to relay a wsh session for a mesh peer (a mesh `--via`), and if so under which scope and bounds?**
Part (a) below is built. Part (b) is only designed, because three choices in it are the owner's and none has a conservative
default that is also useful:

1. **Whether relaying exists in this repository at all.** A relaying pod carries bytes it cannot read for a peer to a target
   it can reach. That makes it a proxy for whoever it admits: whatever the target does to a caller, the relay's address is
   the one the target sees, and a relay that is granted widely is an open door to the pod's network. Nothing else here
   offers a pod's network position to a mesh peer (a mesh grant never gives a machine right).
2. **The scope.** The proposal is `wsh-relay:<target>:open` through the registry, where `<target>` is a name the relaying pod
   chose and listed (never an address the caller sends), default deny, no wildcard that the registry would not already give
   (`wsh-relay:*:open` is the operator's explicit "every target I listed"). The alternative is one scope for all targets
   (`wsh-relay:open`), simpler and coarser.
3. **The bounds.** Proposed: a count of relayed sessions (default 2), a byte and time budget per session, and a refusal to
   relay to a target that is itself a mesh peer (no chains of relays). These are the numbers someone has to pick.

Until those are answered nothing is built: a pod that does not construct the relay offers no relay.

## What is built (part a)

A pod that already runs `WshServices` (objects and MCP for a stock wsh client, [design](wsh-services-on-a-pod.md)) can also
serve it to a **mesh peer**, over a protocol channel instead of a pipe relay. Nothing else becomes reachable: no exec, no
files, no pty, no gateway, no endpoint, no target. Off unless the embedder calls `services.serveOnMesh(service)`.

### Which primitive is the duplex

A **protocol channel** named `wsh` (`service.serveProtocol('wsh', ...)` / `service.openProtocol(peer, 'wsh')`), using its
**raw messages** (`channel.send(bytes)` / `channel.onMessage`), not its request layer: wsh's session is a byte stream with its
own framing and encryption, and a request layer would only add a second one. Checked against what wsh requires:

| wsh requires | What the channel gives | Met? |
| --- | --- | --- |
| Reliable, in order, no duplicates | One mesh channel link: messages are sent in order, in chunks with credit, reassembled (`mesh-channel.mjs`); a lost link ends the channel | yes; a message lost or repeated by a hop on the way is the underlying transport's (WebRTC reliable data channel, WebSocket) and not seen by the layer above |
| Messages of bytes | `send` takes a structured value, bytes included, and delivers a `Uint8Array` | yes; text is not used |
| A known maximum size | `channel.maxMessageBytes` (the link maximum less framing); the adapter hands exactly that to wsh as `maxMessageBytes`, so wsh cuts its writes to it | yes |
| Backpressure by a returned promise | `channel.send` resolves when the link's credit allowed the message; the adapter returns it from wsh's `send`, so the next message waits | yes, and what waits is bounded by wsh's `maxBufferedBytes` |
| One connection per duplex | One `wsh` channel per peer (the protocol host refuses a second open on the same link: `already-open`) | yes |
| Receive wired before the far side can speak | The host speaks first; the opener registers its handler with `openProtocol`'s `setup(channel)`, which runs before the open request is sent, and holds what arrives until the client exists | yes |

### Who may open it

The protocol host's own rule: `protocol:wsh:open` through the registry, **default deny**, asked again for every message of
the channel, so a revocation closes it on the next one. That is the *mesh* question. The *services* question is unchanged and
asked on top: the key that logs in over the channel must hold `wsh-services:open` for its pod id, and each channel it opens
needs `protocol:mcp:open` / `protocol:objects:open` and each tool or root its own scope. One rule is added for this transport:
**the key must be the channel's peer's own** (the key's pod id equals the verified peer of the channel). Over a relay there is
no verified peer to compare with; over a mesh channel there is, and a session whose key is someone else's is a relayed login
(refused with reason `not-the-channel-peer`).

### Sealing and the host key

Sealed, always: `serveWshOverDuplex` serves nothing until the session is sealed and the host is built with
`sealSession: 'require'`, as on the relay; a session starts (audit, indicator) when wsh says it is sealed. The client must
**name the host key**: a pod host's key is its pod key, so the pin is the pod id: `expectHostKey: podIdToFingerprint(peer)`,
which `connectWshServicesOverMesh` fills in from the peer it opened the channel to. (A machine host's key is pinned as in wsh, by
`expectHostKey` or a `known_hosts` entry; not part of this slice.) Login is bound to the host key (`requireChannelBinding`).

### What a hop can see and cannot

A "hop" here is anything that carries the channel's bytes: the transport between the two pods, and, if the pods are not
directly linked, a mesh peer that forwards the link's messages. It sees that a session exists, when it starts and ends, the size
and timing of messages and the plain handshake (the host's public key, the client's user name and public key, the features
each states). It cannot read or alter anything after sealing without ending the session, replay a message, log in as the client or
serve as the host to a client that pinned the pod id. It can drop or delay (the session stalls), or end the link. This is wsh's
own account of a duplex hop; the tests below make a hostile hop do each of those.

### What is not built

- The relaying pod (above), and any `--via` form.
- A **machine** host over a mesh link (the machine side would need a wsh host reachable through a pod: part b).
- Exec, pty, files, the gateway, endpoints, targets over the mesh channel: never, by this design; the same host serves it.
- A browser run of the new path (the in-memory bus and real WebRTC in Node are tested; the browser suite is unchanged).
- Reconnecting a session over a new channel: a new channel is a new session.

## Compatibility

Nothing is added to the wire of the mesh link: `wsh` is one more protocol name on the existing protocol seam, version 1. A peer
that does not serve it answers `mesh.protocol.open` with -32601 (or -32003 when not authorised); the stock wsh client is an
ordinary wsh peer on the far end of the duplex (wsh 0.50). `WshServices` needs wsh 0.50 (the duplex entry
point, and `authorizesItself`, which lets the registry rather than a key capability open the two channels: the `mcp:*`
capability that `WshServices` used to hand every key at wsh's level is gone).
