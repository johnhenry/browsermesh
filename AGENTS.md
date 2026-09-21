# Agent playbook

npm workspaces monorepo, 11 packages under `packages/`, Node >= 26,
`node:test` throughout, orchestrated with Turborepo. No build step — every
package ships plain ESM source (`main`/`exports` point directly at
`src/index.mjs`).

`CLAUDE.md` in this directory is a symlink to this file.

## Workspace structure

Foundational packages other packages build on:

| Package | Role |
| --- | --- |
| [`@johnhenry/browsermesh-primitives`](packages/browsermesh-primitives) | Wire format, Ed25519 identity, CRDTs, capabilities, trust, ACL |
| [`@johnhenry/browsermesh-netway`](packages/browsermesh-netway) | BSD-socket-style virtual networking (streams, datagrams, listeners, policy) |
| [`@johnhenry/browsermesh-pod`](packages/browsermesh-pod) | Pod base class: identity, discovery, peer messaging for any execution context |

Higher-level packages that sit on top of those:

| Package | Role |
| --- | --- |
| [`@johnhenry/browsermesh-core`](packages/browsermesh-core) | Identity, crypto, peer management, trust primitives layer |
| [`@johnhenry/browsermesh-transport`](packages/browsermesh-transport) | Stream multiplexing and transport adapters (WebRTC + WebSocket) |
| [`@johnhenry/browsermesh-priority-mux`](packages/browsermesh-priority-mux) | Application-level priority scheduling for single-stream transports |
| [`@johnhenry/browsermesh-sync`](packages/browsermesh-sync) | State and file sync (delta sync, memory sync, transfer offers) |
| [`@johnhenry/browsermesh-discovery`](packages/browsermesh-discovery) | Peer discovery |
| [`@johnhenry/browsermesh-kernel`](packages/browsermesh-kernel) | Tenant/capability kernel: resource tables, byte streams, services, clock, tracing |
| [`@johnhenry/browsermesh-apps`](packages/browsermesh-apps) | App/agent runtime: marketplace, resources, consensus, payments, quotas, GPU, audit |
| [`@johnhenry/browsermesh-embed`](packages/browsermesh-embed) | Thin widget for embedding a browsermesh-pod-backed workspace on a page |

Packages version independently (see `RELEASING.md`); the root
`package.json` version is only the release marker.

## Build / test commands

```bash
npm install
npm test               # turbo run test --concurrency=4, all workspaces
npm run test:real-peer  # real WebRTC peers — serialised, see below
npm run test:real-gpu   # real headless-Chrome GPU tests, browsermesh-apps only
npm run examples        # run the runnable examples/ (see examples/README.md)
```

There is no `npm run build` — packages ship source directly.

## Repo-specific gotchas

- **`test:real-peer` is deliberately excluded from `turbo run test
  --concurrency=4`.** It stalls under concurrent machine load and is run
  serialised, on its own, in CI. If you touch
  `packages/browsermesh-transport/test/real-peer/` or
  `packages/browsermesh-apps`'s real-peer suite, run `test:real-peer`
  directly rather than relying on the default `npm test`.
- **`REQUIRE_REAL_PEER=1`** makes a missing `node-datachannel` native binding
  fail loudly instead of silently skipping the real-peer suite. CI sets it —
  a skipped suite reports success, which hides a broken install.
- **GPU tests** (`test:real-gpu`, `browsermesh-apps`) drive a real headless
  Chrome+Xvfb instance sharing the machine's one GPU. Follow the `~/gpu.lock`
  convention (see the user-level `~/CLAUDE.md`) before running them.
- **`node-datachannel` version pin**: see `.notes/webrtc-debug-log.md` for
  the full history of a handshake-flake bug tied to this dependency's
  pinned `libdatachannel` version. That file is a debugging session log, not
  conventions — check it before touching the WebRTC transport layer, but
  don't treat it as a style guide.

## Releases

See `RELEASING.md`. Packages version independently and are released with
Changesets (`npm run changeset`, `npm run version-packages`,
`npm run release` / `npm run release:staggered`); releases are tagged
`v<version>`.
