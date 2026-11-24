# What is protected today: message authorship and connection identity

Part of the "what is protected today" notes (tracking issue: #269). Details
and options are in the READMEs of `@johnhenry/browsermesh-pod` ("Who sent this
message?") and `@johnhenry/browsermesh-transport` ("Binding a WebRTC
connection to the pod identities").

## Pod messages (`@johnhenry/browsermesh-pod`)

Protected:

- The sender of a `pod:message`, `pod:rpc-request` or `pod:rpc-response` is the
  key that signed it (its pod id is the hash of that key) or the identity a
  link itself authenticated; never a field the sender or a relay wrote. A relay
  that rewrites, re-addresses, tampers with or injects a message is detected,
  and the message is dropped and counted.
- A copy of a message already accepted is refused within a sliding window per
  sender session. Clocks are not trusted.
- Unsigned messages are accepted only from same-origin transports and window
  messages by default, or where `allowUnsigned` says so; an unsigned
  `pod:rpc-request` is never accepted.

Not protected:

- Confidentiality: a signed message is readable by every peer that forwards it
  and by the relay. End-to-end encryption is tracked in issue #273.
- Messages are not hidden or reordered by a relay, but a relay can drop or
  delay them. Replay state is in memory and bounded: a copy from a forgotten
  session, or sent after the receiver restarted, is not recognised.
- Same-origin delivery trusts the origin: any script of the origin can post
  under any pod id.
- `pod:hello`, `pod:hello-ack` and `pod:goodbye` are unsigned and only change
  the peer list.
- Forwarded (multi-hop) envelopes in `MeshRouter` (`@johnhenry/browsermesh-apps`)
  are not covered by this change: the router's own `from`/`path` fields are
  still written by each hop.

## WebRTC connections (`@johnhenry/browsermesh-transport`)

Protected, when `identity` is passed to `WebRTCPeerConnection` /
`WebRTCMeshManager`:

- Each side proves possession of its pod key over both session descriptions'
  DTLS fingerprints before any application message is accepted, so a
  signalling server that swaps descriptions is detected and the connection is
  closed and reported. The pod id claimed in signalling must equal the hash of
  the key that signed.

Not protected:

- Off by default; `createMeshNode()` does not turn it on.
- Verified with an in-memory duplex and fixed vectors only; not yet run over a
  real `RTCPeerConnection` in a browser (issue #270).
- A peer that does not send a proof is closed after a timeout unless
  `requirePeerBinding: false` is set, in which case it is accepted unbound.
