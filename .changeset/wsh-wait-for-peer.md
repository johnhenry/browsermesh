---
'@johnhenry/browsermesh-transport': patch
'@johnhenry/browsermesh-mcp': patch
'@johnhenry/browsermesh-objects': patch
---

Use wsh 0.54.1's `accept(socket, { waitForPeer })` for the host halves that wait at a pipe relay. `WshPeerLinks` and
`WshServices` accept a waiting half when it reaches the relay, long before a peer pairs with it. They no longer switch the
login deadline off for those hosts: each half is accepted with `waitForPeer`, so wsh's 60 second login deadline starts when
the peer arrives (the relay's paired signal, requested by dialling the half with `?paired=1`, or the peer's first byte when
that comes first or the relay predates the signal). A half that waits is neither refused nor closed however long it waits,
and a peer that pairs and then does not log in is closed at the deadline. A relay that predates the signal ignores
`?paired=1`; the first byte then starts the clock, and a peer that arrives and sends nothing is not bounded by the login
deadline there. With an older wsh (`@johnhenry/wsh/pipe-relay` has no `watchPairing`) the hosts for those halves keep
`loginTimeoutMs: 0`, as before; the optional peer range stays `*`. Nothing new is required of the peer. The in-process test
relay (`@johnhenry/browsermesh-transport/wsh-in-process`) passes the paired signal on. `browsermesh-mcp` and
`browsermesh-objects` are tested against wsh 0.54.1 (documentation only).
