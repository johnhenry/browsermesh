---
"@johnhenry/browsermesh-apps": minor
---

Add runtime-class placement lanes (issue #185 WP4): `RUNTIME_CLASS`/`ISOLATION` constants, `ComputeRequest.constraints.isolation` and `moduleType: 'shell'`, matching `ResourceScorer` rules (hard isolation gate, shell-requires-microvm, `'any'`-lane preference bonus) and a `ResourceScorer.lane()` helper, `ResourceDescriptor.hostedBy`, an `execOnPod()` guard that denies shell execution against isolate-only runtimes (`exitCode: 126` + a `remote_exec_denied` audit record), and a `PLACEMENT_AUDIT` vocabulary with `MeshOrchestrator#recordPlacement()`. All additive with backward-compatible defaults (`moduleType` still accepts `'wasm'|'js'`, `constraints.isolation` defaults to `'any'`); no placement RPC is implemented yet -- that is issue #185's WP2/WP3.
