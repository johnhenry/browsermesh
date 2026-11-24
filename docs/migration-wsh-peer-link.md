# Migration note: the wsh peer link (#273)

Short version: **nothing changes unless you opt in.** The wsh link is a new,
off-by-default transport. This note lists what is new, what an existing
program can notice, and how to adopt it.

## What an existing program can notice

- `TRANSPORT_TYPES` (`browsermesh-transport`) has a fourth member, `'wsh'`. Code
  that iterates it sees it; it is in no default preference order, so no
  negotiator tries it unless told to.
- `MeshTransportNegotiator` takes `require` and has a `required` getter;
  `negotiate()` takes a third argument. Omitted, behaviour is as before.
- `PeerNode.connectToPeer()` rethrows a negotiation failure **only** when its
  negotiator has a required transport. Otherwise a failed negotiation still
  falls through to the registry connection, as before.
- `MeshWshBridge.fingerprint2podId()` / `podId2fingerprint()` now throw a
  `TypeError` on input that is not a 64 character hex fingerprint / a 43
  character base64url pod id. Valid input converts exactly as before. The class
  is otherwise unchanged and is still not constructed by this repository: the
  link layer authenticates with the pod's own key and has no key store to sync.
- `@johnhenry/wsh` is an **optional peer dependency** of
  `browsermesh-transport` (`^0.45.0`). Nothing installs or loads it for you
  unless you use a wsh link.
- The shared pod `TransportAdapter` conformance helper
  (`browsermesh-pod/test/helpers/transport-conformance.mjs`, not published) has
  an optional `senderId` for adapters that stamp `from` with an authenticated
  identity. Existing adapters are unaffected.

## What an older peer does

A peer that has no wsh transport never sees a wsh dial (the dial waits at a
relay for a host that is not there and times out). Two pods that both have the
transport but do not `require` it, and share another transport, link over that
one if the caller listed it after `'wsh'`. A pod that `require`s wsh cannot reach
a peer that does not have it; that is the point.

## Adopting it

1. `npm install @johnhenry/wsh` (`^0.45.0`).
2. Run, or be given, a **pipe relay** both pods can reach. It is wsh's
   `createPipeRelay` from `@johnhenry/wsh/pipe-relay` behind a WebSocket
   upgrade at `<base>/r/<id>` (`?role=host` for the waiting side). The mesh's own
   relay and signaling servers (`browsermesh-servers`) do not speak it today; what
   they would need is listed in [the design note](design/wsh-peer-link.md#what-browsermesh-servers-would-need-not-part-of-this-repository).
3. Choose how:
   - **A `Pod`**: `new WshPodTransport({ identity, relays, authorize, peers })`
     and `pod.boot({ identity, transport })`.
   - **A mesh node**: `createMeshNode({ ..., wsh: { relays } })` (the registry
     decides who may link: `registry.grantCapabilities(peer,
     ['mesh:link:connect'])`), then `node.connectToPeer(podId, { wsh: podId })`.
     Add `require: true` to never fall back to another transport.
   - **Your own negotiator**: `negotiator.registerAdapter('wsh',
     createWshTransportFactory(links))` and either list `'wsh'` in
     `preferenceOrder` or pass `require: 'wsh'`.
4. Decide who may link. The default `authorize` refuses everyone; a pod that only
   dials out can leave it.

## Things to know before relying on it

- It protects the link, not the path. A message forwarded onward over another
  link is as protected as that link. See [`security.md`](security.md).
- `createMeshNode({ wsh: { require: true } })` governs outbound `connectToPeer()`.
  Inbound WebRTC offers are still answered while a WebRTC signaling bus is wired.
- After a reconnect the link is back but neither pod re-announces itself: a `Pod`
  that dropped its peer on the link going away (`WshPodTransport` hands it a
  `pod:goodbye`) learns it again from the next hello. Listen to the transport's
  `peer-up` event and send a hello if you need it immediately.
- The login user name is `pod_<pod id>`: wsh user names must start with a letter
  or underscore and a base64url pod id may not.
