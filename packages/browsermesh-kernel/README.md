# browsermesh-kernel

Capability-secure browser microkernel: resource handles, ByteStreams, IPC,
service mesh, structured tracing, chaos engineering, and tenant isolation —
zero npm dependencies, pure ES modules.

## Provenance

Extracted from the private `clawser` monorepo (previously `packages/browsermesh-kernel` (web/packages/kernel)), where it was manually published to npm, unscoped, as `browsermesh-kernel@0.1.0` (2026-07-17) with no CI ever automating that publish. This is its first release as part of the `@johnhenry/browsermesh` monorepo; the version restarts at `0.0.0` per family convention.


## Modules

| Module | Key Exports |
|--------|-------------|
| constants / errors | `KERNEL_DEFAULTS`, `KERNEL_CAP`, `KERNEL_ERROR`, `KernelError` + 7 subclasses |
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
import { Kernel, KERNEL_CAP } from 'browsermesh-kernel'

const kernel = new Kernel()

// Create a tenant with scoped capabilities
const tenant = kernel.createTenant({
  capabilities: [KERNEL_CAP.CLOCK, KERNEL_CAP.IPC, KERNEL_CAP.STDIO],
  env: { MODE: 'sandbox' },
})

// Use kernel subsystems
const handle = kernel.resources.allocate('stream', myStream, tenant.id)
kernel.tracer.emit({ type: 'custom', tenant: tenant.id })

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
