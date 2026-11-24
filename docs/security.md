# What a mesh link protects, and what it does not

This is the part of [issue #269](https://github.com/johnhenry/browsermesh/issues/269)
("what is protected today") that is about links between pods. It states what the
code in this repository does for each way two pods can be connected. It is
written from the source, not from intent: where this repository's code does
not do something, it says so. The relay and signaling servers live in another
repository (`browsermesh-servers`) and are not covered by anything here.

Per-package implementation status (the other half of #269) is not in this
document.

## Per link type

| Link | Confidentiality against the network | Confidentiality against a relay | Who the peer is, as far as this repo's code checks | Notes |
| --- | --- | --- | --- | --- |
| `BroadcastChannelTransport` (pod) | the browser's same-origin isolation | no relay | any same-origin context on that channel name | no cryptography |
| `WebSocketTransport` (pod, relay protocol) | TLS when the URL is `wss://`, nothing when it is `ws://` | **none**: the relay reads every envelope | the relay says who sent it (`source`); the message may also carry `from`. Neither is checked against a key here | the relay `register` frame names a pod id; this client sends no proof of key |
| `WebSocketTransport` / `WebTransportTransport` (transport package) | as above | none | none | optional size-bucket `padding` and `jitterMs` hide sizes and timing from a network observer, not from the relay |
| `WebRTCTransport` | DTLS (standard data channel encryption) | the signaling relay carries offers and answers, including DTLS fingerprints | the signaling names the peer's pod id; the offer and answer are not signed with the pod key in this repository, so a signaling relay that rewrites them can sit in the middle | a renegotiation whose DTLS fingerprint changes is rejected |
| **wsh link** (`WshPeerLinks`, opt-in) | sealed end to end (authenticated encryption, X25519 + ML-KEM-768) | **sealed: ciphertext only** | the key wsh authenticated, which must hash to the pod id claimed; the dialler pins the host to the pod id it meant to reach; the listener asks the registry | see below |

## The wsh link

Protected, between two pods that both run it:

- **Confidentiality and integrity against the relay and the network.** After the
  key exchange every byte is an authenticated encrypted frame with a strict
  counter. A relay that flips a byte, replays or reorders a frame or injects a
  plain one cannot get anything delivered: a frame that does not open ends the
  link, and a plain message on a sealed session is dropped.
- **Peer authentication bound to the pod id**, in both directions. The dialler
  pins the host key to the pod id it intended to reach, so a relay that hands the
  dialler a different host is refused before a credential is sent. The listener
  refuses a login whose claimed pod id is not the hash of the key that signed it,
  and asks its `authorize` callback (default: nobody; `createWshAuthorizer` asks
  `PeerRegistry`/`MeshACL`) before any mesh frame.
- **The sender of every message on the link is the session's key.** The
  transport sets `from` to it and drops a message that names someone else; no
  field inside a message decides who sent it.
- **Channel binding**: the login signature covers the host key, so it cannot be
  replayed at another host.
- **Least privilege on the listening side**: the authenticated key is granted
  only the mesh endpoint, nothing else the wsh host could do.

Not protected:

- **Traffic analysis.** The relay sees who dials which rendezvous id, when, how
  many bytes, and the size and timing of every record. Frames are not padded and
  sends are not jittered on this link.
- **The handshake before login.** The login user name (the pod id), the login
  public key and the host key proof are readable by the relay. They are not
  secrets.
- **A compromised peer.** The link proves whose key it is, not whose hands.
- **Availability.** A relay can drop, delay or end a link, and can keep a
  rendezvous slot busy. The listening side keeps spare slots and redials.
- **Anything forwarded onward over a link that is not sealed** (below).
- **Peers that do not run it.** Nothing about it is negotiated with a peer that
  has no wsh transport; such a peer is simply reached some other way, or not at
  all if `require: 'wsh'` was asked for.

## Multi-hop forwarding

End to end protection ends at the pod that terminates the link. If pod B
receives something from A over a wsh link and sends it on to C over a WebRTC
channel, a relay, or any other link, A's guarantee covers A to B only; what C
gets is as protected as the B to C link, and B can read and change it.

Is a forwarded message distinguishable from a direct one?

- **At the link layer, yes.** A message arrives on a link tagged with that
  link's authenticated peer. A message that carries a `from` or `podId` naming a
  third pod is dropped (reason `foreign-sender`), never delivered under the
  third pod's name, so a forwarder cannot pass its own link off as someone
  else's.
- **At the application layer, no.** `mesh-relay`, `mesh-rpc` and the other
  services put the original requester inside an envelope sent by the
  forwarder. The receiver sees the forwarder as the sender and gets the inner
  claim as the forwarder's claim. Nothing marks which links on the path were
  sealed, so a multi-hop path is as strong as its weakest link.

## Turning it on

Off by default. See the
[transport README](../packages/browsermesh-transport/README.md#sealed-peer-links-over-wsh)
for `WshPeerLinks`, `WshPodTransport` and `MeshTransportNegotiator`'s `require`,
and the [design note](design/wsh-peer-link.md) for the threat model.
