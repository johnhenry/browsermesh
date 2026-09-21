# browsermesh-kernel

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Fbrowsermesh-kernel.svg)](https://www.npmjs.com/package/@johnhenry/browsermesh-kernel)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Fbrowsermesh-kernel.svg)](LICENSE)

Capability-secure browser microkernel: resource handles, ByteStreams, IPC,
service mesh, structured tracing, chaos engineering, and tenant isolation —
zero npm dependencies, pure ES modules.

## Provenance

Extracted from the private `clawser` monorepo (previously `packages/browsermesh-kernel`), where it was manually published to npm, unscoped, as `browsermesh-kernel@0.1.0` (2026-07-17) with no CI ever automating that publish. This is its first release as part of the `@johnhenry/browsermesh` monorepo; the version restarts at `0.0.0` per family convention.

## Cross-package relationship

`browsermesh-kernel` has zero npm dependencies, including on other packages in this monorepo -- `kernel.mjs`/`caps.mjs` have no static or dynamic import of anything outside this package. Two relationships exist anyway, both deliberately duck-typed rather than hard dependencies:

- `Kernel#networkFor()` accepts any object shaped like `@johnhenry/browsermesh-netway`'s `VirtualNetwork` and wraps it in a `ScopedNetwork` to hand a sandboxed tenant its `caps.net` view -- a real, wired integration point, but one that works with any conforming object, not specifically `browsermesh-netway`'s class.
- `@johnhenry/browsermesh-apps`'s `kernel-mesh.mjs` lazily `import()`s this package's `Kernel` at runtime (an optional peer) to gate a tenant's mesh capability (`caps.mesh`) behind kernel-enforced permissions, composable alongside sync and mesh-relay on the same `PeerNode` -- see `browsermesh-apps`'s README, "Putting it all together."


## Modules

| Module | Key Exports |
|--------|-------------|
| constants / errors | `KERNEL_DEFAULTS`, `KERNEL_CAP`, `KERNEL_ERROR`, `KernelError` + 8 subclasses |
| resource-table | `ResourceTable` — handle-based `res_N` resource allocation |
| byte-stream | `BYTE_STREAM`, `isByteStream`, `asByteStream`, `createPipe`, `pipe`, `devNull`, `compose` |
| clock / rng | `Clock` (fixed for testing), `RNG` (seeded xorshift128+) |
| caps | `buildCaps`, `requireCap`, `CapsBuilder` — capability enforcement |
| message-port | `KernelMessagePort`, `createChannel` — IPC |
| service-registry | `ServiceRegistry` — `svc://` service lookup with `onLookupMiss` |
| tracer | `Tracer` — ring-buffer, `AsyncIterable` trace event stream |
| logger | `Logger`, `LOG_LEVEL` |
| chaos | `ChaosEngine` — fault injection |
| env | `Environment` — immutable env vars |
| signal / stdio | `SIGNAL`, `SignalController` (TERM/INT/HUP + `AbortSignal`), `Stdio` |
| kernel | `Kernel` — the facade tying every subsystem together |

## Install

```bash
npm install @johnhenry/browsermesh-kernel
```

## Usage

```js
import { Kernel, KERNEL_CAP } from '@johnhenry/browsermesh-kernel'

const kernel = new Kernel()

// Create a tenant with scoped capabilities
const tenant = kernel.createTenant({
  capabilities: [KERNEL_CAP.CLOCK, KERNEL_CAP.IPC, KERNEL_CAP.STDIO],
  env: { MODE: 'sandbox' },
})

// Use kernel subsystems
const handle = kernel.resources.allocate('stream', myStream, tenant.id)
kernel.tracer.emit({ type: 'custom', tenant: tenant.id })

// Tenant-scoped resource access: get/getTyped/drop are bound to tenant.id and
// throw ResourceOwnershipError if the handle belongs to a different tenant.
const myResources = kernel.resourcesFor(tenant.id)
myResources.get(handle)

// Clean up
kernel.destroyTenant(tenant.id)
kernel.close()
```

## Origin

Extracted from the [clawser](https://github.com/erisera-code/clawser) browser
agent workspace, where it underpins workspace tenants, shell pipes, MCP
service registration, provider cost tracing, sandboxed code execution, and
daemon IPC — all as opt-in hooks (`clawser-kernel-integration.js`) that are
no-ops when the kernel isn't active.

## License

MIT
