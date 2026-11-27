# Agent playbook

npm workspaces monorepo, 17 packages under `packages/`, Node >= 26,
`node:test` throughout, orchestrated with Turborepo. No build step — every
package ships plain ESM source (`main`/`exports` point directly at
`src/index.mjs`).

`CLAUDE.md` in this directory is a symlink to this file.

## Workspace structure and build order

Packages are declared in `package.json`'s `workspaces` array. Foundational
packages other packages build on:

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
| [`@johnhenry/browsermesh-objects`](packages/browsermesh-objects) | wsh's remote-object layer over a protocol channel, authorised per root and per action |
| [`@johnhenry/browsermesh-meshctl`](packages/browsermesh-meshctl) | External CLI for the hosted-pods control surface (`meshctl`, itself a pod; peer-depends on apps, core, pod, primitives, optionally transport and wsh). 0.1.0 is on npm (published 2026-11-25); the sealed relay path (`--wsh-relay`) has been run once against a minimal deployed pod host, `--signaling` (WebRTC) and VMM-backed hosts are still unrun (see its README's Status) |
| [`@johnhenry/browsermesh-embed`](packages/browsermesh-embed) | Thin widget for embedding a browsermesh-pod-backed workspace on a page |
| [`@johnhenry/browsermesh-mcp`](packages/browsermesh-mcp) | A page's WebMCP tools over a protocol channel (peer-depends on wsh and apps) |
| [`@johnhenry/browsermesh-ingress`](packages/browsermesh-ingress) | Real HTTP in, a mesh pod answers: request forwarder and CLI (peer-depends on apps) |
| [`@johnhenry/browsermesh-egress`](packages/browsermesh-egress) | A pod lends its network to peers under per-destination grants: TCP, UDP, a fetch form (the provider is the HTTP client and sees it) and name lookup, consumer with a netway backend, a `browsermesh-egress` CLI (peer-depends on apps and netway; the Node dialer on wsh's address guard) |
| [`@johnhenry/browsermesh-realm`](packages/browsermesh-realm) | **Private, in progress, not published.** Realms: signed realm descriptors, root rotation, roles, issuer-signed credentials and the issuer ledger, as pure functions (design: [`docs/design/realms.md`](docs/design/realms.md)); peer-depends on primitives only |

Packages version independently (see `RELEASING.md`); the root
`package.json` version is only the release marker.

**`browsermesh-core` and `browsermesh-apps` have a narrow, intentional
circular relationship**, not shown by the strict top-down ordering above:
`browsermesh-core` lazily `import()`s `ScheduledTask` from
`browsermesh-apps` in `peer-tools.mjs`, and `browsermesh-apps` lazily
`import()`s several `browsermesh-core` exports across
`mesh-hardening.mjs`/`mesh-keepalive.mjs`/`key-distribution.mjs`/
`mesh-bootstrap.mjs`. Both directions are optional peerDependencies and
both imports are lazy (`await import()`, never a static top-level import),
so neither package requires the other to load -- see
`packages/browsermesh-core/README.md`'s "Cross-package relationship"
section for the full accounting. This is why both packages'
`peerDependencies` name each other.

## The verification loop (before every push)

```bash
npm install
npm test               # turbo run test --concurrency=4, all workspaces, then the docs checks
                       # (scripts/*.test.mjs: docs/security.md's generated facts;
                       #  refresh with `node scripts/status-facts.mjs --write`)
npm run test:real-peer  # real WebRTC peers — serialised, see below
npm run test:real-gpu   # real headless-Chrome GPU tests, browsermesh-apps only
npm run examples        # run the runnable examples/ (see examples/README.md)
npm run test:browser    # real Chromium, real WebRTC/WebSocket, strict CSP (tests/browser/README.md)
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

## New-package definition of done

Adding a package under `packages/` means all of the following, not just
`npm init`. This is what every existing package does; the repo has no
`tsconfig.json` anywhere and no build step.
- `package.json` with `main` and `exports` pointing directly at the plain ESM
  source (`src/index.mjs`), a `files` array (`src`, `LICENSE`, `README.md`, plus
  `bin` where there is a CLI), `"engines": { "node": ">=26.0.0" }` matching the
  root, `"license": "MIT"`, and `repository` with `directory`
  (`packages/browsermesh-<name>`).
- A `LICENSE` file in the package directory.
- The package is picked up by the root `workspaces` glob (`packages/*`); no
  edit is needed there. Put it in the tables above, in dependency order.
- Tests under `test/*.test.mjs` run by `node:test`, with a `test` script in the
  package, so `turbo run test` runs it.
- `README.md` with the npm-version and license badge row, a short
  statement of what the package is, an `## Install` section and a `## License`
  section (model: `packages/browsermesh-core/README.md`). A provenance note
  only for a package imported from elsewhere. The root README and this file's
  package tables each get a row.
- For a public package: an entry in `scripts/staggered-publish.sh` after every
  workspace package it depends on (`scripts/publish-list.test.mjs` checks this),
  and a changeset (`npm run changeset`) so the release PR makes its first
  `CHANGELOG.md` entry. A private package (`"private": true`) is not in that
  list, and says in its README that it is private and unpublished.
- A row for it in `docs/security.md`'s status table, and a refresh of the
  generated facts block (`node scripts/status-facts.mjs --write`);
  `npm run test:docs` fails if a package has no row.

## Releases

See `RELEASING.md`. Packages version independently and are released with
Changesets (`npm run changeset`, `npm run version-packages`,
`npm run release` / `npm run release:staggered`); releases are tagged
`v<version>`.
