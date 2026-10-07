---
"@johnhenry/browsermesh-pod": minor
---

Add the pod host protocol (`src/host-protocol.mjs`, issue #185's hosted-pods control surface): the one lane-agnostic verb set — `spawn`, `status`, `send`, `exec`, `snapshot`, `restore`, `drain`, `list` — that every later surface (the `browsermesh-apps` pod-host service, `mesh://` routes, `meshctl` tools, an external CLI, a supervisor) projects.

- `POD_HOST_VERB` / `POD_LANE` / `POD_LIFECYCLE` plus `POD_LIFECYCLE_TRANSITIONS` and `canTransition(from, to)` — the `docs/hosted-pods.md` §5.3 state machine as data, with a terminal `gone`.
- `POD_LANE_VERBS` / `laneSupports(lane, verb)`: which lane can honour which verb is static, not a runtime surprise. `exec`/`snapshot`/`restore` are `ELANE` on the `isolate` and `browser` lanes today.
- `validatePodSpec(spec)` and `validateVerbRequest(verb, payload)` returning `{ok, value}` / `{ok, errors}`. Only two defaults are applied (`lane` from `run.kind`, `restart.policy: 'never'`); unknown keys are an error at every level rather than silently ignored.
- Wire shapes `createHostRequest` / `createHostResponse` / `createHostEvent` over `pod-host:request|response|event`, with `POD_HOST_ERROR` codes (`EACCES`, `ENOENT`, `EEXIST`, `EINVAL`, `ENOTSUP`, `ELANE`, `ETIMEDOUT`, `EBUSY`) and a `PodHostDriverError` carrying them.
- The `PodHostDriver` interface as a JSDoc typedef (not a base class) plus `createUnsupportedDriverMethod(verb, lane)`, and `InMemoryPodHostDriver` — a complete reference driver with a configurable lane, a real lifecycle state machine, an injectable `exec` and `onEvent()` fan-out.

This module lives in `browsermesh-pod`, not `browsermesh-apps`, deliberately: a Worker or a microVM guest can import the protocol without pulling in the app/agent runtime. `POD_LANE`'s strings are kept identical to `browsermesh-apps`' `RUNTIME_CLASS` rather than imported across the package boundary.
