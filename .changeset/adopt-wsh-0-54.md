---
'@johnhenry/browsermesh-transport': patch
'@johnhenry/browsermesh-mcp': patch
'@johnhenry/browsermesh-objects': patch
---

Adopt wsh 0.54.0. wsh now closes a host connection that has not completed its login 60 seconds after the host accepted
it. The wsh link (`WshPeerLinks`) and `WshServices` accept a host half at a pipe relay when it connects, long before a peer
pairs with it, so with that default every idle half would have been closed and re-opened each minute; their hosts for
those halves are now created with `loginTimeoutMs: 0` (no deadline between connecting to the relay and the peer's first
message, which is what they had before). A mesh protocol channel keeps wsh's default, since its peer logs in as soon as it
opens it. Nothing new is sent on the wire and an older wsh ignores the option. `browsermesh-mcp` and `browsermesh-objects`
are tested against wsh 0.54.0 (documentation only).
