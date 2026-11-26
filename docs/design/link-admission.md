# Link admission: a restricted state for links whose peer is not yet known

Status: implements the prerequisite in `realms.md` section 5.5 and section 11 (stage 2). It carries no realm logic: it is the
place where an unknown peer can be held, talk to ONE handler, and be promoted or dropped.

## The seam

`createLinkAdmission({ maxRestricted = 8, deadlineMs = 10000, maxFrameBytes = 16384, decide, handler, onEvent })`, in
`browsermesh-apps` (`src/link-admission.mjs`). It is transport neutral: a transport hands it a **channel** and the seam owns
everything else.

- `decide({ peerKey, transport, proven })` returns `'allow' | 'deny' | 'restrict'`, sync or async. A throw, a rejection or any
  other value is `'deny'`. `proven` is true when the link authenticated `peerKey` (wsh: always; WebRTC: only when the identity
  binding verified, so false under `webrtcAllowUnboundPeers` with a peer that sent no proof).
- `handler({ peerKey, transport, proven, send(frameObject), onFrame(cb), promote(), close(reason) })` is called once per
  restricted link and owns the exchange. The seam does not know what the frames mean.
- `admit({ peerKey, transport, proven, channel })` is what a transport calls for a link `decide` said to restrict.
  `channel` is `{ send(frame), onFrame(cb), onClose(cb), close(reason), adopt() }`, all supplied by the transport.

## States of a link

```
            admit()                 promote()
 (new) --------------> restricted ---------------> promoted   (the transport adopts it; the seam forgets it)
                          |   \
            cap full      |    \ close(reason) / deadline / peer closed / handler threw
                 v        v     v
              refused   closed (reason)
```

`promote` and `close` are one-shot together: the first wins, later calls return false. A link in `restricted` has a deadline
(`deadlineMs`, from `admit`); at expiry it is closed with reason `deadline` and `onEvent` fires. The cap counts links in
`restricted`; a link over it is refused with reason `restricted-full` and never reaches the handler. Counters
(`stats()`): `restricted` (now), `opened`, `promoted`, `closed`, `refusedFull`, `deadlines`, `denied`, `allowed`,
`framesIn`, `framesOut`, `framesDropped`.

Inbound frames larger than `maxFrameBytes` (string length, byte length, or JSON length of an object) are dropped and counted;
the handler never sees them. An outbound frame over the cap throws and is counted.

## How each transport integrates

**The invariant in both**: while restricted, no frame reaches the node's normal handlers, and the node sends nothing but the
handler's frames. It holds because a restricted link is not yet a session of the node: nothing subscribed to it.

**wsh** (`browsermesh-transport`). `WshPeerLinks({ authorize, admission })`. `authorize` may now return `{ restricted: true }`
(additive: `true`, `false`, `{ expires }` are unchanged; default is still "nobody"). A restricted verdict logs the peer in (with
`endpoint:mesh-admission`, below) and the link is NOT registered: no `peer-up`, no `message` events, no
entry in `peers()`. Its frames go to `admission.admit(...)`, its sends come from the handler. `promote` registers it exactly
as a normal inbound link (tie-break, `peer-up`, reading continues on the same decoder). A restricted verdict with no
`admission` configured is a refusal. The restricted peer is granted `endpoint:mesh-admission` instead of `endpoint:mesh`, and
the host serves a second endpoint of that name, so wsh's own capability check (not a flag we correlate) keeps a restricted key
off the mesh endpoint whatever races. A dialler that finds `mesh` refused by policy opens `mesh-admission`. `attachWshLinks`
needs no change: a promoted link announces `peer-up` as any inbound link does. In `browsermesh-apps`,
`createWshAdmissionAuthorize(admission, inner)` builds the `authorize`: the inner authorizer (the registry's, today's default)
is asked first, and only a peer it refuses is put to `decide` with `transport: 'wsh'`, `proven: true`. `createMeshNode`
does this when given `admission`.

**WebRTC** (`createMeshNode({ admission })`). Opt-in. The factory's `onIncomingConnection` fires when an inbound data channel
has opened; with `admission` it first asks `decide({ peerKey, transport: 'webrtc', proven: connection.bound })`: `allow` adopts
as today, `deny` closes, `restrict` calls `admit` with a channel over the adapter and adopts only on `promote`. Without the
option the code path is today's, unchanged.

## Older transports fail closed

`{ restricted: true }` is a verdict only a transport that understands it may receive: `WshPeerLinks` before it granted a full
`endpoint:mesh` on ANY truthy verdict. So `WshPeerLinks` calls `authorize(peer, { restricted: true })` (and sets the static
`WshPeerLinks.supportsRestrictedAdmission = true`), and `createWshAdmissionAuthorize` returns the restricted verdict only when
called with `{ restricted: true }`. Called with one argument (an older transport) a `restrict` decision is a refusal and
`onEvent` gets `restricted-unsupported`; `createMeshNode({ admission, wsh })` logs
`mesh-bootstrap:admission-restricted-unsupported` when the loaded class lacks the flag. `allow` and `deny` are the same either
way. The apps peer range on transport is not raised for this.

## Slots and the cap

A wsh listener keeps `listenSlots` (default 2) host halves waiting per relay. Reading `#openSlot`: a half is replaced the moment
its peer pairs (the first message on the socket, the relay's paired signal), not when its link ends. So a held stranger does
**not** keep a listening slot for the deadline; the slot is refilled after one relay round trip. What a stranger holds is a
login in the host (and a socket), and what bounds that is `maxRestricted`. The danger that remains is a burst: more strangers
arriving than there are waiting halves, inside one refill round trip, can leave an honest dialler unpaired for that round trip;
the cap does not help with that (those strangers are not yet restricted when they pair). A test pins the first claim (an honest
peer links while a stranger is held, with `listenSlots: 1`).

Defaults: `maxRestricted = 8`, `deadlineMs = 10 s`, `maxFrameBytes = 16 KiB`. The cap is deliberately larger than `listenSlots`:
it limits what is held, not what is listened for, and refill is not tied to it. A deployment whose relay limits waiting halves
per id should keep `maxRestricted` below that limit. `maxRestricted` and the deadline apply per seam instance: give each
`WshPeerLinks` its own, or share one to share a cap across transports (`createMeshNode` shares one).

## What is NOT done

- No realm messages, credentials or grants: the handler is the next package's.
- The wsh read buffer for a restricted link still uses the hub's `maxFrameBytes` (1 MiB) for header checks; the seam's smaller
  cap drops frames after they are decoded, so memory is bounded by `maxRestricted * maxFrameBytes`, not by the seam's cap.
- A local `connectToPeer()` to a peer whose inbound WebRTC link is held reuses that connection and adopts it as a caller
  session: the restricted state binds what the REMOTE can make us deliver, not what our own code chooses to dial.
- Outbound links (links we dial) are never restricted: we chose the peer.
- No `Hello.features` pre-auth hint (5.5, optional later).
- Registry access re-checks do not cover a restricted link; it has no registry entry until promoted. After promotion the
  default `watchWshAccess` still applies: a promoted peer the registry does not allow is closed at the next access change for
  it, so a handler that promotes should first record the peer's grant (the realm package's job).
- Over WebRTC a hand-out of the same connection twice is gated once.
