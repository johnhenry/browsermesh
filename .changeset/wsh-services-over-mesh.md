---
'@johnhenry/browsermesh-transport': minor
---

`WshServices` can be served to a mesh peer over a protocol channel (wsh 0.50's `@johnhenry/wsh/duplex`), not only through a pipe relay: `services.serveChannel(channel)`, `services.serveOnMesh(service, { protocol })` and, for the dialling side, `connectWshServicesOverMesh(service, peer, credentials)` (the real wsh client, the pod id pinned as the host key, sealed). Off unless called; objects and MCP only, as over a relay. Opening the channel is `protocol:wsh:open` in the registry (default deny); the existing services grants are asked on top; the key that logs in must be the channel's verified peer's own (a login for another key is refused as `not-the-channel-peer`). Nothing is added to the mesh link: `wsh` is one more protocol name.

`WshServices` now needs `@johnhenry/wsh` 0.50 (it was 0.49): the registry, not a capability named on the key, opens its two channels (`authorizesItself`), so the `mcp:*` capability it used to give every key at wsh's level is gone. The peer range of the package is unchanged (the rest of it still works from 0.45).
