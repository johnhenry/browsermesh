---
"@johnhenry/browsermesh-apps": minor
---

Add the pure placement logic for hosted pods: `planPlacement()` (lane, verb, health, isolation boundary, capability and admission-limit matching, requester quota, ranking), `HostHealth` (per-host circuit breaker), `PlacementLedger`, and `createHostPool()` (spawn, drain, drain-a-host with make-before-break re-placement, restart decisions) over any `PodHostDriver`. The restart policy and backoff curve the pod supervisor already used are now shared as `decideRestart()` / `restartDelayMs()` / `policyWantsRestart()`; the supervisor's behaviour is unchanged. All additive: nothing uses the new exports unless called.
