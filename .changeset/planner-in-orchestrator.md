---
"@johnhenry/browsermesh-apps": minor
---

Placement decisions can go through `planPlacement()`: `MeshOrchestrator#placePod()` (and `releasePlacement()`), the `constraints` argument of the `meshctl_spawn` tool, and new `decidePlacement()` / `resolveRequesterTrust()` exports. The requester's trust is read from the local trust graph; with no requester, no trust graph or no usable value the requester is untrusted and is placed only behind a language or hardware boundary that the host states. A podspec `budget` is refused unless a budget check is configured and accepts it, a per-requester pod quota is checked before placement, and each decision is audited. Pod hosts now also state their `boundary` in `describe()` (additive; hosts that do not state one count as having none). Callers that pass no constraints are unchanged.
