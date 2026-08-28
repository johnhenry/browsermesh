# browsermesh

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
```

## Provenance

This repo consolidates 10 previously-scattered packages into one family,
following the `@johnhenry/*` scope-migration convention (imported packages
restart their version at `0.0.0`). See each package's own README for its
specific prior-publish history.
