---
"@johnhenry/browsermesh-apps": patch
---

Link admission fails closed against an older transport. `createWshAdmissionAuthorize` returns `{ restricted: true }` only when called as `authorize(peer, { restricted: true })`, which the transport now does; a transport that calls `authorize(peer)` and grants a full mesh link on any truthy verdict gets `false` for a `restrict` decision instead (reported through the new `onEvent` option, which `createMeshNode` logs). `createMeshNode({ admission, wsh })` logs `mesh-bootstrap:admission-restricted-unsupported` when the loaded `WshPeerLinks` lacks `supportsRestrictedAdmission`.
