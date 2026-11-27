# @johnhenry/browsermesh-meshctl

## 0.3.0

### Minor Changes

- 2b6b5c8: `meshctl hosts` now exits non-zero when EVERY listed host failed (#432). This is a behaviour change: `hosts` used to exit 0 even when every host refused this identity, so a script that checked only the exit code missed "nothing worked". The document is unchanged (every host's entry is still printed, a failed one with its own `error`). The exit code is 0 if at least one host answered; if all failed, the code they share (3 if all were refusals such as `WSH_REFUSED`, 6 if all timed out), or 1 when they failed in different ways. The README's exit-code table and `--help` say so. Minor rather than patch because meshctl is 0.x and an exit code a script may branch on changes.

### Patch Changes

- c163a2b: Concurrent dialers against one host no longer run past their timeout (#431).

  - `WshPeerLinks` dialling: a dial the relay closes at once because no host half is waiting for it (every half at the host's rendezvous id is taken while the host refills) is now retried with jittered backoff inside `connectTimeoutMs`, so a burst of operators is served as the host refills its halves instead of failing `WSH_UNREACHABLE`. The whole dial, retries included, stays within `connectTimeoutMs`.
  - `meshctl --wsh-relay`: `--timeout` now also bounds the dial (it is passed as `connectTimeoutMs`). Before, only each request used it and the dial waited the link layer's 15 s default, so a dialler held at the relay outlived `--timeout`. An explicit `wsh: { connectTimeoutMs }` still wins.

## 0.2.0

### Minor Changes

- 8624d68: `meshctl realm ...`: the operator and member commands for realms (`docs/design/realms.md`, section 8). Additive: no existing command or flag changes.

  - **Commands.** `realm create`, `issue`, `revoke`, `rotate`, `ledger`, `join`, `ls`, `inspect`, `export`, and `invite`, which exists only to answer `EREALM_NOT_IMPLEMENTED` (exit 2, pointing at key-bound `realm issue`: there is no keyless credential in v1). One JSON document per command, with the existing exit-code table plus stable `EREALM_*` codes. They work on local files only, in a store set by `--realm-dir` (default `~/.config/browsermesh/realms/`, `0700` directories and `0600` files).
  - **Key custody.** The root and issuer keys are sealed with `@johnhenry/keyvault` (`browsermesh-realm-root`), unsealed only for the signing call and imported non-extractable. The passphrase comes only from `--passphrase-env <VAR>` or a `--passphrase-file` that must be mode `0600`; never from argv. `export` never returns a key. `issue` signs with the issuer key only, so the root can stay off the issuing machine. One ledger per realm keeps serials from colliding.
  - **Members.** `join` verifies a descriptor against the pinned realm id and makes an independent per-realm identity (random, in the realm's profile directory). Seed-derived per-realm identities are a follow-up. `inspect` shows the stored descriptor and local profile and says it cannot list live peers; there is no `realm leave` (delete the profile).
  - **Dependencies.** `@johnhenry/browsermesh-realm` is an optional peer, loaded on first use: without it the realm commands exit 2 and say what to install, and every other command is unchanged. `@johnhenry/keyvault` becomes a dependency.

## 0.1.0

### Minor Changes

- 9654f23: First release of `@johnhenry/browsermesh-meshctl`: the `meshctl` command, a command-line client for hosted pods. It is itself a pod: it joins the mesh and spawns, lists, sends to, snapshots, supervises and drains pods on the hosts that allow it, printing one JSON document per command. It reaches a host through a sealed, key-authenticated link through a relay (`--wsh-relay`), through WebRTC and a signalling server (`--signaling`), or against in-process demo hosts (`--loopback`).

  `@johnhenry/browsermesh-transport` and `@johnhenry/wsh` are optional peers, needed only for `--wsh-relay` and `--signaling`; without them those flags say what to install and every other command works (the real-mesh code is no longer loaded at start). The `vm` command needs a repository checkout and is not available from the package. The sealed relay path (`--wsh-relay`) has been run once against a deployed pod host (the in-memory driver) and passed, refusals included; the WebRTC path (`--signaling`) and hosts backed by a real VMM or isolate runtime have not been exercised.

- abbd00e: A supervised pod can be placed, and re-placed after every exit, by the placement planner under the requester it was supervised for. `createPodSupervisor().supervise(host, spec, { requesterId, minBoundary })` records the requester; with either option stated, `'auto'` and every restart ask the planner (`MeshOrchestrator#decidePod()`, new: the decision and audit of `placePod()` without the spawn, or an injected `placer`), under that requester's trust and never the supervisor's own identity, preferring the current host or avoiding a lost one. If that requester's rules no longer allow any host, the supervisor emits `supervisor:replacement-refused` and `supervisor:gave-up` with the reason `replacement-refused:<plan code>`, audits both (`supervisor_replacement_refused`), spawns nothing and leaves the pod `dead`; `EBUSY` is retried as before. Without either option nothing changes (`pickHost`, `pickAutoHost()`, a restart on its own host). `list()` reports `requesterId` for such pods.

  `meshctl pods supervise auto` accepts `--requester <pubKey>` and `--min-boundary`, as `pods spawn auto` does, with the same validation, and hands placement and restarts to the planner under that requester.
