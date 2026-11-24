---
'@johnhenry/browsermesh-transport': minor
---

A relaying pod (a mesh `--via`): `WshRelay` carries another pod's sealed wsh session to a target without being able to read it, and `connectWshServicesViaRelay(service, relayPod, target, credentials)` dials through it with the real wsh client, pinning the target's host key (a pod id for a pod). Off unless constructed. A requester needs `protocol:wsh-relay:open` and `wsh-relay:<target>:open` for the exact target (a pod id, or a name the operator mapped to a pipe relay URL and rendezvous id; never an address the requester supplies); a wildcard target is refused unless `wideTargets: true`. Bounds: `maxSessions` (default 2), a byte budget, a time budget and an idle timeout per session; refusals and ends are named and audited (pod ids, target, bytes, duration; never content); a relayed session is not relayed onward; revoking the grant ends it at once.

`WshServices` takes `acceptVia`: pod ids of relaying pods allowed to carry a key that is not their own (default empty, so nothing changes unless listed). Nothing is added to the mesh link: `wsh-relay` is one more protocol name.
