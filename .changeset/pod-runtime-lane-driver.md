---
"@johnhenry/browsermesh-pod": minor
---

Add `createRuntimeLaneDriver()` and the `PodRuntime` adapter interface: a `PodHostDriver` over anything that can run a hosted module, with a host-side module catalog (a podspec never names a path), refused loader/limit environment variables (`NODE_*`, `LD_*`, `DYLD_*`, `UV_*`, `OPENSSL_*`), admission limits and the lifecycle events. A runtime claiming the isolate lane must declare a language or hardware boundary. New subpath `@johnhenry/browsermesh-pod/node-runtimes` with two runtimes that need no native dependency: `createWorkerThreadsRuntime()` (boundary `none`, not a security boundary) and `createPermissionProcessRuntime()` (boundary `process`, Node permission model). Additive: existing exports and behaviour are unchanged.
