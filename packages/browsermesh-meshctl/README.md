# browsermesh-meshctl

[![license](https://img.shields.io/npm/l/%40johnhenry%2Fbrowsermesh-meshctl.svg)](LICENSE)

External CLI for the browsermesh hosted-pods control surface
([issue #185](https://github.com/johnhenry/browsermesh/issues/185), item 5).
`meshctl` is itself a pod: it boots its own mesh identity, joins the mesh,
and issues the same `pod-host:request` envelopes the in-mesh
`createPodHostClient()` uses. There is no separate admin API -- `meshctl`
has no more authority over a host than any other granted peer does.

> **Publishing.** This package is `"private": true` for now. It is a real
> workspace member (turbo runs its tests, `npm install` links it), but
> whether/when it ships to npm as `@johnhenry/browsermesh-meshctl` is a
> separate decision -- see [RELEASING.md](../../RELEASING.md).

## Contents

- [Why this exists](#why-this-exists)
- [Install](#install)
- [The `cf`-style JSON contract](#the-cf-style-json-contract)
- [Exit codes](#exit-codes)
- [Identity](#identity)
- [Connection modes: `--loopback` vs. a real mesh](#connection-modes---loopback-vs-a-real-mesh)
- [Commands](#commands)
- [`vm`: a different animal](#vm-a-different-animal)
- [Known limitations](#known-limitations)
- [Peer dependencies](#peer-dependencies)
- [License](#license)

## Why this exists

`packages/browsermesh-pod/src/host-protocol.mjs` defines the eight
lane-agnostic pod-host verbs (`spawn`, `status`, `send`, `exec`, `snapshot`,
`restore`, `drain`, `list`) as plain data; `packages/browsermesh-apps/src/
pod-host-service.mjs` is the gated, audited service that speaks them over a
mesh. Everything after that -- `mesh://` routes, `meshctl` LLM tools, an
external CLI, a supervisor -- is a projection of that one service
(`docs/hosted-pods.md` §8a, "Everything else is a projection"). This
package is that projection for an operator sitting at a terminal: it never
re-implements access control, podspec validation, or verb dispatch, it just
calls `createPodHostClient()`.

## Install

Not published yet (see the note above). Inside this monorepo:

```bash
npm install   # root install links the workspace + `meshctl` on PATH via node_modules/.bin
npx meshctl --help
```

## The `cf`-style JSON contract

Every `meshctl` command prints **exactly one JSON document to stdout**,
Cloudflare's newer `cf` CLI's convention: pretty-printed when stdout is a
TTY, compact otherwise, so a human gets something readable and a script
piping output gets one `JSON.parse()`-able line without having to strip
ANSI or guess where the data starts. `--json` forces compact (even on a
TTY); `--pretty` forces pretty (even off one).

```jsonc
// success
{ "ok": true, "result": <command-specific JSON> }
// failure -- always on STDERR, never stdout
{ "ok": false, "error": { "code": "EACCES", "message": "not authorized for 'pod-host:spawn'" } }
```

`--quiet` suppresses `meshctl`'s own diagnostic logging (connection
progress, `vm`'s host-pod log lines) on stderr -- it never affects stdout,
which only ever carries the one JSON document (or, for `watch`, the NDJSON
event stream described below).

The one deliberate exception is `meshctl watch <host>`: it streams one
compact JSON object per line (NDJSON) as `pod-host:event`s arrive, until
`SIGINT`, and only then prints the usual `{ok, result}` summary document as
its last line. A log stream is not a single document by nature; forcing it
into one would mean buffering indefinitely.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | ok |
| 1 | generic failure (anything not listed below -- e.g. `EEXIST`, `EINVAL`, `EBUSY`) |
| 2 | usage error (bad flags/args, caught before anything touches the mesh) |
| 3 | `EACCES` -- not authorized for that verb on that host |
| 4 | `ENOENT` -- no such pod (or, for `--spec`, no such file) |
| 5 | `ELANE` / `ENOTSUP` -- the lane structurally can't do this verb, or this driver doesn't implement it |
| 6 | `ETIMEDOUT` -- the host never answered within `--timeout` |

Every `POD_HOST_ERROR` code from `host-protocol.mjs` round-trips as
`error.code` in the JSON document regardless of which exit code it maps
to, so a caller that wants the fine-grained reason (`ELANE` vs. `ENOTSUP`,
both exit 5) still has it.

## Identity

`meshctl` persists its own Ed25519 identity (as a JWK) to
`--identity <file>`, default `~/.config/browsermesh/meshctl-identity.json`
(mode `0600`, directory `0700`), created on first run. It reuses
`@johnhenry/browsermesh-core`'s `MeshIdentityManager` for the
export/import round trip rather than hand-rolling it -- the same call
`spikes/isolate-pod-host/src/identity-jwk.mjs` makes for a Durable
Object's storage, just against a file instead of `ctx.storage`.

```bash
npx meshctl identity
# {"ok":true,"result":{"podId":"...","label":"meshctl","identityPath":"/Users/you/.config/browsermesh/meshctl-identity.json","created":false}}
```

A host only ever grants capabilities to a `podId` -- without a persisted
identity, every invocation would be a different, ungranted stranger.

## Connection modes: `--loopback` vs. a real mesh

Every command except `identity` and `vm` (see below) needs exactly one of:

- **`--loopback`** -- an in-process mesh with no network at all: `meshctl`
  boots its own `PeerNode`, plus (by default) two demo hosts --
  `isolate-host` (lane `isolate`) and `node-host` (lane `node`) -- each
  running `InMemoryPodHostDriver`, linked to `meshctl` over a minimal
  in-memory duplex transport (the same pattern `examples/
  13-pod-host-service.mjs` uses). `meshctl`'s identity is granted every
  verb each lane supports on every demo host automatically. `<host>`
  arguments accept either the host's podId or its label (`isolate-host`/
  `node-host`).

  **Hosts, and any pods on them, live only as long as that one `meshctl`
  process.** `InMemoryPodHostDriver` is in-memory by design -- there is no
  way for a second `meshctl --loopback` invocation to see a pod the first
  one spawned. `--loopback` is for a single script, an example, a test, or
  interactively poking at the verb set -- not a standing demo host.

- **`--signaling <ws://...> [--relay <ws://...>]`** -- joins a real mesh.
  `--signaling` points at a `browsermesh-servers/signaling`-compatible
  WebSocket server and is used to bootstrap real WebRTC connections
  (`@johnhenry/browsermesh-transport`'s `WebRTCMeshManager` +
  `MeshTransportNegotiator`, the same pieces `@johnhenry/browsermesh-apps`'s
  `createMeshNode()` wires together). `--relay` optionally opens a second
  connection to a relay server as a data-plane fallback transport; it is
  opened and closed correctly but **not yet wired into the pod-host
  request path** -- see [Known limitations](#known-limitations).

  Real-mode `<host>` arguments are always the host's podId (pubKey) --
  there is no label indirection, and no built-in discovery. Pass
  `--host <pubKey>` (repeatable) for any command that considers every
  known host (`hosts`, `pods spawn auto`).

`meshctl` deliberately does **not** call `@johnhenry/browsermesh-apps`'s
`createMeshNode()` directly for the real path: that helper always mints a
*fresh* identity via `wallet.createIdentity(label)`, which would silently
defeat identity persistence (a host's grant to `meshctl` would be
worthless on the next run). `src/real-mesh.mjs` inlines the same core
wiring `createMeshNode()` does, built around the already-loaded,
persisted identity instead.

## Commands

```
meshctl <group> <cmd> [args] [flags]
```

| Command | Notes |
| --- | --- |
| `identity` | No mesh connection. Prints `podId`/`label`/`identityPath`/`created`. |
| `hosts` | Describes every known host: `lane`, `verbs`, `runtimeClasses`, `shellBackend`, `deploymentSupport`. |
| `host describe <host>` | Describes one host. |
| `pods list <host>` | Every pod the host tracks (tombstones included). |
| `pods spawn <host\|auto> --name <n> --lane <l> --kind skill\|module\|rootfs\|command --ref <r> [--entry <e>] [--input <json>] [--limits <json>] [--caps a,b] [--env K=V...] [--restart never\|on-failure\|always] [--spec <file.json>]` | `--spec` reads a base podspec from disk; every other flag then overrides the matching key. `auto` picks a host by `--lane` -- see below. |
| `pods status <host> <name>` | One pod's lifecycle state. |
| `pods send <host> <name> --payload <json> [--to <podId>]` | Deliver a message to a pod. |
| `pods exec <host> <name> -- <argv...>` | Run `argv` inside a pod (lane-dependent: `ELANE` on `isolate`/`browser`). |
| `pods snapshot <host> <name>` | Freeze a pod to durable storage (lane-dependent). |
| `pods restore <host> <name>` | Thaw a snapshotted pod (lane-dependent). |
| `pods drain <host> <name> [--cascade]` | Stop a pod, notifying peers. |
| `watch <host>` | Streams `pod-host:event`s as NDJSON until `SIGINT`. |
| `vm ...` | A different connection model entirely -- [see below](#vm-a-different-animal). |

**Global flags**, valid everywhere: `--loopback`, `--signaling <ws://...>`,
`--relay <ws://...>`, `--identity <file>`, `--host <ref>` (repeatable),
`--timeout <ms>` (default 10000), `--json`, `--pretty`, `--quiet`,
`--help`/`-h`.

### `pods spawn auto`

Picks a host offering `--lane` without the caller naming one. It prefers
`MeshOrchestrator#selectComputeTarget()`'s real scoring
(`preferRuntimeClass: lane`) over every known host's `describe()` --
cheap, since those `describe()` calls are made anyway -- and prints which
host was chosen and `chosenVia` (`'orchestrator'` or `'lane-match'`).

An **isolate**-lane host never advertises the `compute` capability the
orchestrator's scorer requires (it has no `exec`, by design --
`pod-host-service.mjs`'s own documented limitation), so `auto --lane
isolate` always falls back to directly matching `describe().lane`. For
`microvm`/`node` hosts (which do advertise `compute`), the orchestrator
path runs first.

## `vm`: a different animal

`meshctl vm <spawn|exec|snapshot|restore|drain|status> ... [--dry-run]`
talks to a **local** `VmPodHost` directly (`spikes/vm-pod-host`'s
Firecracker driver) -- no `--loopback`/`--signaling`, no identity, no
`PeerNode` at all. `pods` goes over the mesh to a host someone else is
running; `vm` IS the host, running in this same process, for operating
directly on a microVM pod host box (or, everywhere else, its `--dry-run`
demo mode: no real Firecracker/jailer/`/dev/kvm` needed, every planned
host command and Firecracker API call is recorded and printed instead of
executed).

This folds `spikes/vm-pod-host/src/cli.mjs`'s operator CLI under `meshctl`
by **importing its functions** (`demoSpawnOpts`, `runSpawn`, `runExec`,
`runSnapshot`, `runRestore`, `runDrain`, `runStatus`), not reimplementing
them -- `src/vm-bridge.mjs` is the glue, the spike's own `cli.mjs` stays a
thin wrapper around the exact same functions for its own standalone use,
and the spike's own test suite (`spikes/vm-pod-host/test/`) stays green.

## Known limitations

- **`--relay` is wired, not yet load-bearing.** It opens and closes a
  second `WebSocketTransport` (relay mode) cleanly, but nothing in the
  pod-host request path uses it yet -- only the `'webrtc'` adapter is
  registered on the transport negotiator. A relay-backed transport
  adapter (so a host unreachable over WebRTC -- symmetric NAT, no TURN --
  is still reachable) is follow-up work.
- **The real-mesh path was wired, not exercised end to end.** Real WebRTC
  connectivity needs `node-datachannel`'s native binding.
  `test/real-mesh-wiring.test.mjs` verifies the wiring (a `PeerNode`
  carrying the *persisted* identity's podId, the signaling transport
  opening/registering/closing, `--relay` opening its own transport, the
  full `main()` chain not hanging) against a fake, in-process signaling
  transport -- the same guard pattern `packages/browsermesh-apps/test/
  real-peer/mesh-bootstrap.test.mjs` uses elsewhere in this monorepo. The
  `--loopback` path is exercised fully, against two real `InMemoryPodHostDriver`
  hosts (isolate + node lanes), through every one of the eight verbs.
- **`watch` can only forward events for pods it knows to ask about.** The
  wire protocol has no "subscribe to every pod on this host" primitive --
  a host only forwards events for pods a requester named in some prior
  request. `watch` polls `list()` and calls `status()` on any new pod
  name it hasn't seen yet (every 250ms by default) to register interest
  without changing pod state; a pod that spawns and drains faster than
  that poll interval can still be missed.

## Peer dependencies

Matches how `@johnhenry/browsermesh-apps` declares its own workspace
peers: `@johnhenry/browsermesh-primitives`, `@johnhenry/browsermesh-pod`,
`@johnhenry/browsermesh-core`, `@johnhenry/browsermesh-apps` are required;
`@johnhenry/browsermesh-transport` is an optional peer, needed only for
the real-mesh (`--signaling`) path.

## License

MIT
