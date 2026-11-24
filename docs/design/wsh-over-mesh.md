# wsh over a mesh link

Item 7 of [#334](https://github.com/johnhenry/browsermesh/issues/334): a pod serves, or dials, a wsh session over a
channel between two pods instead of over a relay. Built on wsh 0.50's `@johnhenry/wsh/duplex` (`createDuplexSocket`,
`serveWshOverDuplex`, `connectWshOverDuplex`) and its design note `spec/duplex-binding.md`, which this page does not repeat.

## Decided (owner, 2026-11-24)

The question this note asked was: should a pod relay a wsh session for a mesh peer (a mesh `--via`), and under which scope and
bounds? The owner's answer: **yes, with a per-target grant.** Part (b) is specified below ("The relaying pod") and built in
`packages/browsermesh-transport/src/wsh-relay.mjs`.

- Off by default; nothing in the repository constructs it. A pod relays only when the embedder creates and starts a `WshRelay`
  AND the requesting peer holds the registry grant `wsh-relay:<target>:open` for THAT target.
- The target is named exactly: a **pod id** (that pod's wsh services host, reached over the mesh) or a **name the relaying pod's
  operator mapped** to a pipe relay URL and rendezvous id. Never an address the requester supplies: the relaying pod is not an
  open proxy and not an SSRF tool.
- A wildcard is refused unless acknowledged (`wideTargets: true`, as `wideEntries` is for wsh's object roots).
- Bounds, no chains, audit and revocation: below.

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

- Chains of relays: refused, by design (below).
- A machine host served BY a pod over a mesh link: a machine host is reached through a relaying pod's mapped name (below), not served by the pod.
- Exec, pty, files, the gateway, endpoints, targets over the mesh channel to a pod's services: never, by this design; the same host serves it.
- A browser run of the new paths (the in-memory bus and real WebRTC in Node are tested; the browser suite is unchanged).
- Reconnecting a session over a new channel: a new channel is a new session.

## The relaying pod (`WshRelay`)

A pod that is linked to both a requester A and a target T carries A's wsh session to T without being able to read it. The
relaying pod never terminates wsh: it moves opaque byte messages between two duplexes and nothing else.

**Protocol.** A opens the protocol channel `wsh-relay` to the relaying pod R (the protocol host's own `protocol:wsh-relay:open`,
default deny: the mesh question), and sends ONE control message `{ t: 'open', target, hops: 0 }`. R answers
`{ t: 'ok' }` or `{ t: 'refused', reason }` (and closes). After `ok`, every message of the channel is a `Uint8Array`, the
duplex of wsh's `connectWshOverDuplex`, and R forwards it unchanged to the **leg**; whatever the leg sends goes back the same way.
A message that is not bytes after `ok` ends the session.

**The leg.** For a target that is a pod id R opens the protocol `wsh` on T (T's `WshServices.serveOnMesh`) from its own mesh service;
for a named target R dials the pipe relay URL and rendezvous id its operator mapped to that name (`targets: { name: { relay, id } }`)
and the bytes are carried on that socket as they are. T must be linked to R, and T's own rules still apply: R needs
`protocol:wsh:open` at T, and because the key that logs in is A's and not R's, T lists R in `acceptVia` (a `WshServices` option, empty by
default; the key must still hold `wsh-services:open` at T). T therefore decides which relays may carry keys to it.

**Who may ask.** Two grants, both default deny: `protocol:wsh-relay:open` (the control channel) and
**`wsh-relay:<target>:open`** for the exact target of THIS session, asked of the registry per session and again whenever the
registry says the requester's access changed: revoking it ends the relayed session at once. `<target>` is a pod id (43 characters)
or a configured name (`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`, never shaped like a pod id). A target the operator did not
configure by name, and that is not a pod id, is `unknown-target`. A grant with a wildcard target (`wsh-relay:*:open`) would let a
peer name any pod, so it is refused (`wildcard-grant`, checked by asking the registry about the literal target `*`) unless the relay
was created with `wideTargets: true`; `targets` entries named `*` are refused at creation the same way.

**Bounds** (each refusal and end is named): at most `maxSessions` relayed sessions at once (default 2, `too-many-sessions`),
one per requesting pod (structural: the protocol host allows one `wsh-relay` channel per peer, a second open is `already-open`), `maxBytes` per session in both directions together (default
64 MiB, ends with `byte-budget`), `maxDurationMs` per session (default one hour, `time-budget`) and `idleMs` without traffic (default
five minutes, `idle`).

**No chains.** A relayed session cannot be relayed onward. By construction: R's outbound leg only ever opens the protocol `wsh` on a
pod or dials a mapped URL: never `wsh-relay`, so there is no way to name another relaying pod as a hop. By marker: the control
message carries `hops`, which a requester sends as 0; a relaying pod refuses anything else, and a missing marker (`chain`), so a
forwarded request (which would carry a hop count) never relays again. The grant model backs it: a requester needs a
`wsh-relay:<target>:open` grant for the exact target, and an operator grants none for a pod that only relays. A request that names the
relaying pod itself or the requester is refused (`loop`). A relay has ONE `wsh` channel per target pod at a time (the protocol host's
rule), so a second session to the same pod through the same relay is refused `target-busy` until the first ends.

**What it sees and can do.** It sees who asks (pod id), the target, that a session exists, when it starts and ends, the size and timing
of every message, and the plain handshake (the host's public key, the user name, the client's key and features). It cannot read or
alter anything after sealing without the session ending, replay, log in as the client, or serve as the target to a client that pinned the
target's key: the client names the target's host key (a pod id for a pod; the operator-given fingerprint for a named machine), so a relay
that answers for the target is refused by the client. It can drop, delay, end the session, or refuse it. It cannot tell a sealed session
from a plain one by looking; it can enforce only that it forwards `wsh` duplex bytes between exactly two legs and never terminates wsh. A
client that asks for a plain session through a relay gets one: the sealed-only rule is the TARGET's (`WshServices` serves nothing
unsealed), and `connectWshServicesViaRelay` never asks for anything else.

**Audit and indicator.** `onAudit` events `relay-open` (requester, target), `relay-refused` (reason), `relay-close` (requester,
target, bytes, duration, reason): pod ids, never content. As with the services, `start()` needs an `indicator` (`connected(who, control)`
/ `disconnected(who)`, `control.stop()` ends that session) or `unattended: true`, so a page that relays shows that it does.

## Compatibility

Nothing is added to the wire of the mesh link: `wsh` is one more protocol name on the existing protocol seam, version 1. A peer
that does not serve it answers `mesh.protocol.open` with -32601 (or -32003 when not authorised); the stock wsh client is an
ordinary wsh peer on the far end of the duplex (wsh 0.50). `WshServices` needs wsh 0.50 (the duplex entry
point, and `authorizesItself`, which lets the registry rather than a key capability open the two channels: the `mcp:*`
capability that `WshServices` used to hand every key at wsh's level is gone).
