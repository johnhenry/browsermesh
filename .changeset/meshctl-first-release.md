---
'@johnhenry/browsermesh-meshctl': minor
---

First release of `@johnhenry/browsermesh-meshctl`: the `meshctl` command, a command-line client for hosted pods. It is itself a pod: it joins the mesh and spawns, lists, sends to, snapshots, supervises and drains pods on the hosts that allow it, printing one JSON document per command. It reaches a host through a sealed, key-authenticated link through a relay (`--wsh-relay`), through WebRTC and a signalling server (`--signaling`), or against in-process demo hosts (`--loopback`).

`@johnhenry/browsermesh-transport` and `@johnhenry/wsh` are optional peers, needed only for `--wsh-relay` and `--signaling`; without them those flags say what to install and every other command works (the real-mesh code is no longer loaded at start). The `vm` command needs a repository checkout and is not available from the package. The sealed relay path (`--wsh-relay`) has been run once against a deployed pod host (the in-memory driver) and passed, refusals included; the WebRTC path (`--signaling`) and hosts backed by a real VMM or isolate runtime have not been exercised.
