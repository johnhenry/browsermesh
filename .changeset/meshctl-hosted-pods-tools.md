---
"@johnhenry/browsermesh-apps": minor
---

Add `meshctl` LLM tools for the hosted-pods control surface (issue #185 §8a item 4): five new `BrowserTool`s in `src/orchestrator.mjs`, projecting `pod-host-service.mjs`'s eight-verb protocol into the same tool-calling shape `meshctl_pods`/`meshctl_exec`/etc. already use.

- `MeshctlSpawnTool` (`meshctl_spawn`) — `{host, name, lane?, run, limits?, caps?, env?, budget?, restart?}`, validated via `validatePodSpec()` before ever touching a host. `host: 'auto'` (or omitted) auto-selects a host matching the requested lane: primarily via `listComputeCandidates()` (the same descriptors `meshctl_compute` reads), falling back to the new `MeshOrchestrator#listPodHosts()` for the `isolate`/`browser` lanes `listComputeCandidates()` cannot see (no `exec` there, so no `compute` capability — a documented, pre-existing limitation). "The orchestrator proposes, the host accepts": a refusal from the chosen (or named) host is reported as-is, never silently retried elsewhere.
- `MeshctlSnapshotTool`/`MeshctlRestoreTool` (`meshctl_snapshot`/`meshctl_restore`) — `{host, name}`.
- `MeshctlHostedPodsTool` (`meshctl_hosted_pods`) — `{host}`, a table-plus-JSON listing of what a host is tracking.
- `MeshctlHostsTool` (`meshctl_hosts`) — lists known pod hosts (lane, verbs, runtime classes) via `MeshOrchestrator#listPodHosts()`, a new read-only method reading runtime-registry peers tagged with `metadata.podHost`.
- Every `PodHostDriverError` code is mapped to a human-readable, lane-aware message (e.g. `ELANE` on `snapshot`/`restore` against an isolate host: "isolate pods cannot snapshot/restore; Durable Object hibernation is automatic, not a verb you drive") instead of surfacing the raw errno-shaped code.
- `registerMeshctlBuiltins()`'s `meshctl` text dispatcher grows matching `spawn <host|auto> <name> --lane <lane> --kind <kind> --ref <ref> [--entry <entry>]`, `snapshot <host> <name>`, `restore <host> <name>`, `hosted <host>` and `hosts` subcommands, with the same usage-string-on-error convention as the existing ones.
- `createMeshctlTools()`/`registerOrchestratorTools()`/`createOrchestratorToolRegistry()` (`mesh-orchestrator-tools.mjs`) now wire all 13 `Meshctl*Tool`s, up from 8.

`examples/15-agent-spawns-hosted-pod.mjs` runs the whole story end to end: a deterministic test `llmFn` driving a real `createAgentRuntime()` loop that calls `meshctl_hosts`, `meshctl_spawn` (`host: 'auto'`), `meshctl_hosted_pods`, `meshctl_snapshot`, `meshctl_restore`, and the pre-existing `meshctl_drain` — composing the five new tools with the original eight.
