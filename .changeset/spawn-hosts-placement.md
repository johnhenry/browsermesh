---
"@johnhenry/browsermesh-apps": minor
---

Pod hosts that can spawn pods but have no shell (the isolate and browser lanes) are now visible to placement scoring. `listComputeCandidates(constraints, { includeSpawnHosts: true })` and `selectComputeTarget({ includeSpawnHosts: true })` also return them, as `spawn` + `runtime:<lane>` descriptors that never carry `compute`; without the option nothing changes, so shell execution is still only ever routed to hosts with a shell. `pickAutoHost()` uses the option.
