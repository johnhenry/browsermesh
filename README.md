# browsermesh

[![CI](https://github.com/johnhenry/browsermesh/actions/workflows/ci.yml/badge.svg)](https://github.com/johnhenry/browsermesh/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Fbrowsermesh-primitives.svg)](LICENSE)

Full documentation: [opensource.johnhenry.me/browsermesh](https://opensource.johnhenry.me/browsermesh/)

Peer-to-peer mesh networking for browser environments: cryptographic
identity, CRDTs, capabilities and trust (`@johnhenry/browsermesh-primitives`),
a BSD-socket-style virtual network layer
(`@johnhenry/browsermesh-netway`), a Pod base class for execution contexts
(`@johnhenry/browsermesh-pod`), and the higher-level building blocks —
identity/keyring, transport multiplexing, state sync, discovery, and app
runtime — that sit on top of them.

## Packages

| Package | Description |
| --- | --- |
| [`@johnhenry/browsermesh-primitives`](packages/browsermesh-primitives) | Wire format, Ed25519 identity, CRDTs, capabilities, trust, ACL |
| [`@johnhenry/browsermesh-netway`](packages/browsermesh-netway) | BSD-socket-style virtual networking (streams, datagrams, listeners, policy) |
| [`@johnhenry/browsermesh-pod`](packages/browsermesh-pod) | Pod base class: identity, discovery, peer messaging for any execution context |
| [`@johnhenry/browsermesh-core`](packages/browsermesh-core) | Identity, crypto, peer management, and trust primitives layer |
| [`@johnhenry/browsermesh-transport`](packages/browsermesh-transport) | Stream multiplexing and transport adapters |
| [`@johnhenry/browsermesh-sync`](packages/browsermesh-sync) | State and file sync (delta sync, memory sync, transfer offers) |
| [`@johnhenry/browsermesh-discovery`](packages/browsermesh-discovery) | Peer discovery |
| [`@johnhenry/browsermesh-apps`](packages/browsermesh-apps) | App/agent runtime: marketplace, resources, consensus, payments, quotas, GPU, audit |
| [`@johnhenry/browsermesh-kernel`](packages/browsermesh-kernel) | Tenant/capability kernel: resource tables, byte streams, services, clock, tracing |
| [`@johnhenry/browsermesh-embed`](packages/browsermesh-embed) | Thin widget for embedding a browsermesh-pod-backed workspace on a page |

## Development

npm workspaces + Turborepo. No build step — every package ships plain ESM
source (`main`/`exports` point directly at `src/index.mjs`).

```bash
npm install
npm test          # turbo run test across all packages
npm run examples  # run the runnable examples/ (see examples/README.md)
```

## Examples

[`examples/`](examples/) has 5 self-contained, runnable demonstrations
covering the five foundational packages — real identity/signing, two Pods
discovering and messaging each other, a virtual-network loopback stream,
kernel capability enforcement, and CRDT sync convergence. Run with
`npm run example:01` (etc.) or `npm run examples` for all of them.

## Honest limitations

- **A revoked peer can still read data it already decrypted.**
  `browsermesh-apps`' `CloudStorage` distributes a bucket's AES-256-GCM key
  to each granted peer over a signed, point-to-point channel; revoking a
  grant (`GrantLog.revoke()`) stops *future* key distribution and chunk
  replication, but there is no key rotation on revoke anywhere in the
  design. A since-revoked peer that retained the key -- or any chunk
  ciphertext plus the key -- can still decrypt that data offline,
  indefinitely. This is a fundamental property of handing symmetric key
  material to multiple independent parties (the same is true of a
  downloaded S3 object after a bucket policy changes), not a gap a future
  phase closes. See `packages/browsermesh-apps/README.md`'s CloudStorage
  section.
- **Concurrent writes to the same key resolve silently, with no merge.**
  `browsermesh-apps`' `LWWMap` (used by both `CloudStorage`'s manifest sync
  and `MeshKv`) resolves conflicting writes by caller-supplied timestamp,
  with ties broken by whichever `nodeId` string sorts greater -- no
  server-clock arbitration, no per-field merge, no surfaced conflict. Two
  peers writing different content to the same key "at the same time"
  produce one silent winner. This mirrors un-versioned S3's own default
  behavior and is a stated, permanent limitation, not a backlog item. See
  `packages/browsermesh-apps/docs/building-mesh-services.md` §7.

## Family

browsermesh isn't just a standalone mesh-networking stack -- two of its
foundational packages are also consumed directly by a sibling repo outside
this monorepo, as a drop-in transport upgrade.

- **[`@johnhenry/dialback`](https://github.com/johnhenry/dialback)** --
  dialback's built-in transport is a WebSocket plus one shared secret string.
  Its optional `dialback/browsermesh` module swaps that for real, per-agent
  Ed25519 identity, built directly on this monorepo's
  [`@johnhenry/browsermesh-netway`](packages/browsermesh-netway) (virtual
  networking: `StreamSocket`/`VirtualNetwork`/`Listener`) and
  [`@johnhenry/browsermesh-primitives`](packages/browsermesh-primitives)
  (`PodIdentity`, an Ed25519 keypair). Both are declared as optional
  `peerDependencies` on dialback's side -- requiring plain `dialback` never
  touches either package.

## Provenance

This repo consolidates 10 previously-scattered packages into one family,
following the `@johnhenry/*` scope-migration convention (imported packages
restart their version at `0.0.0`). See each package's own README for its
specific prior-publish history.
