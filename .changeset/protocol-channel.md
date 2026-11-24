---
"@johnhenry/browsermesh-apps": minor
---

Add the protocol-channel seam (`protocol-channel.mjs`, also `@johnhenry/browsermesh-apps/protocol-channel`): a documented duplex interface for layered protocols (`send`, `onMessage`, `request` with cancel and progress, `notify`, `onRequest`, `onNotification`, `onClose`, `peer`, `maxMessageBytes`), opened by name with `openProtocol` / `serveProtocol` over a mesh-channel link. Opening is authorised per protocol through `PeerRegistry.checkAccess` with the scope `protocol:<name>:open` (default deny, registry wildcards), re-checked on every use; `listProtocols` discovers what a peer will let you open. `createProtocolHost` works over any mesh-channel link, including a bare in-memory duplex. Nothing is served or authorised unless configured.
