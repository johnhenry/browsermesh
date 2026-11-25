---
'@johnhenry/browsermesh-apps': minor
'@johnhenry/browsermesh-meshctl': minor
---

A supervised pod can be placed, and re-placed after every exit, by the placement planner under the requester it was supervised for. `createPodSupervisor().supervise(host, spec, { requesterId, minBoundary })` records the requester; with either option stated, `'auto'` and every restart ask the planner (`MeshOrchestrator#decidePod()`, new: the decision and audit of `placePod()` without the spawn, or an injected `placer`), under that requester's trust and never the supervisor's own identity, preferring the current host or avoiding a lost one. If that requester's rules no longer allow any host, the supervisor emits `supervisor:replacement-refused` and `supervisor:gave-up` with the reason `replacement-refused:<plan code>`, audits both (`supervisor_replacement_refused`), spawns nothing and leaves the pod `dead`; `EBUSY` is retried as before. Without either option nothing changes (`pickHost`, `pickAutoHost()`, a restart on its own host). `list()` reports `requesterId` for such pods.

`meshctl pods supervise auto` accepts `--requester <pubKey>` and `--min-boundary`, as `pods spawn auto` does, with the same validation, and hands placement and restarts to the planner under that requester.
