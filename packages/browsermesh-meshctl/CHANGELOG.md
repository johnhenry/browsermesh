# @johnhenry/browsermesh-meshctl

## 0.1.0

### Minor Changes

- 9654f23: First release of `@johnhenry/browsermesh-meshctl`: the `meshctl` command, a command-line client for hosted pods. It is itself a pod: it joins the mesh and spawns, lists, sends to, snapshots, supervises and drains pods on the hosts that allow it, printing one JSON document per command. It reaches a host through a sealed, key-authenticated link through a relay (`--wsh-relay`), through WebRTC and a signalling server (`--signaling`), or against in-process demo hosts (`--loopback`).

  `@johnhenry/browsermesh-transport` and `@johnhenry/wsh` are optional peers, needed only for `--wsh-relay` and `--signaling`; without them those flags say what to install and every other command works (the real-mesh code is no longer loaded at start). The `vm` command needs a repository checkout and is not available from the package. The sealed relay path (`--wsh-relay`) has been run once against a deployed pod host (the in-memory driver) and passed, refusals included; the WebRTC path (`--signaling`) and hosts backed by a real VMM or isolate runtime have not been exercised.

- abbd00e: A supervised pod can be placed, and re-placed after every exit, by the placement planner under the requester it was supervised for. `createPodSupervisor().supervise(host, spec, { requesterId, minBoundary })` records the requester; with either option stated, `'auto'` and every restart ask the planner (`MeshOrchestrator#decidePod()`, new: the decision and audit of `placePod()` without the spawn, or an injected `placer`), under that requester's trust and never the supervisor's own identity, preferring the current host or avoiding a lost one. If that requester's rules no longer allow any host, the supervisor emits `supervisor:replacement-refused` and `supervisor:gave-up` with the reason `replacement-refused:<plan code>`, audits both (`supervisor_replacement_refused`), spawns nothing and leaves the pod `dead`; `EBUSY` is retried as before. Without either option nothing changes (`pickHost`, `pickAutoHost()`, a restart on its own host). `list()` reports `requesterId` for such pods.

  `meshctl pods supervise auto` accepts `--requester <pubKey>` and `--min-boundary`, as `pods spawn auto` does, with the same validation, and hands placement and restarts to the planner under that requester.
