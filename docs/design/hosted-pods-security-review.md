# Hosted pods: what a pod can reach on its host (security review)

Part of [#185](https://github.com/johnhenry/browsermesh/issues/185). A review
of what code running as a hosted pod can reach, per lane, with the tests that
pin each denial that can be tested on a development machine, and a list of
what is **not defended**. Written from the code, not from the issue.

Reading guide. A *pod* is the code a requester caused to run on a host. The
*host* is the machine and process that run it. "Denied" means a test in this
repository fails if it stops being denied; "not tested here" means the claim
rests on the design or on documentation and has not been exercised (the
Firecracker lane has never booted a VM: see
`docs/design/hosted-pods-firecracker.md` section 11).

## Lanes reviewed

| Lane / runtime | Runs requester code? | Boundary | Where |
| --- | --- | --- | --- |
| microVM (Firecracker) | yes (anything in the guest) | hardware (KVM), jailer, cgroups, per-pod network policy | `spikes/vm-pod-host` |
| node: permission-model child process | modules from the host's catalog only | `process` (not a sandbox) | `packages/browsermesh-pod/src/node-runtimes.mjs` |
| node: `worker_threads` | modules from the host's catalog only | `none` | same |
| isolate: Worker / Durable Object | **no**: runs a fixed echo pod; `run.ref` is not loaded | V8 isolate (workerd) | `spikes/isolate-pod-host` |
| isolate: `isolated-vm` runtime (`createIsolatedVmRuntime()`) | modules from the host's catalog only | `language`, in the host's own process | `packages/browsermesh-pod/src/isolate-runtime.mjs` |
| isolate: `workerd` runtime | specified only (`pod-runtime.mjs`) | `language` | not built |
| browser: in-page, CDP, extension | yes (a page) | a tab / a browser context / an extension world | `packages/browsermesh-pod/src/browser-host-driver.mjs`, `spikes/browser-*-host` |

## 1. Per-lane reach

Rows are what a pod could reach on the host; each cell says what happens and
how it is checked.

### microVM

| Reach | Result |
| --- | --- |
| Host files | Only the pod's own rootfs copy and nothing else is attached (virtio-block). The shared base image is never attached: each pod gets a private copy inside its jail (`cp --no-clobber`, mode 0600, owned by the VMM's identity). Tests: `vm-pod.test.mjs` (rootfs), `driver.test.mjs` (two pods, two disks; catalog lookup by own property), `vm-config.test.mjs` (staging). A VMM escape lands as an unprivileged per-VM uid (never 0) in a chroot with cgroup limits: `jailer.test.mjs`, `host-pod.test.mjs`. Not tested here: the jail itself. |
| Network | Per-pod nft table, default-deny: input from the TAP dropped; source address and MAC pinned; IPv6 dropped; egress only to public addresses (private, loopback, link-local including the metadata address, CGNAT, multicast, reserved dropped) unless the operator lists a destination; replies only into the guest. Tests: `network-policy.test.mjs` (the rules as emitted), `vm-pod.test.mjs` (a failing rule command aborts the boot: no VM starts without its policy). Not tested here: the rules against a kernel (`test:real-firecracker` checks the metadata and host addresses). |
| Environment variables | None of the host's: the guest sees a kernel command line with only an address triple and a signaling URL (validated; no credentials or query: `vm-config.test.mjs`). The podspec's `env` is not passed at all today. |
| Host process memory | Not reachable except through VMM device emulation or a KVM/Firecracker escape (not defended, below). |
| Other pods | Separate disks, separate TAPs with pinned source addresses, no forwarding between guests, a distinct VMM uid per VM by default. The VMM is stopped by pid after an exact `--id` check, so stopping one pod cannot stop another (`jailer.test.mjs`, `vm-pod.test.mjs`). |
| The control plane | The vsock is the host agent's only channel in; the guest cannot reach the host's TAP address (input dropped). |

### node: permission-model child process

| Reach | Result |
| --- | --- |
| Host files | Read access to only the entry file, the hosted module and the catalog entry's `readPaths`; no write at all. Denied, tested: reading a file the test creates and `/etc/hosts`; writing (`node-runtimes.test.mjs`, "what a permission-model child process cannot reach"). |
| Network | Denied, tested: a connection to a listener the test runs is refused by the runtime and the listener sees none. |
| Processes | Starting a process or a worker is denied, tested. |
| Environment variables | Only what the podspec names (the child is started with an explicit `env`), tested: the host's `HOME`, `PATH` and a secret set by the test are absent. `NODE_OPTIONS`, `NODE_*`, `LD_*`, `DYLD_*`, `UV_*`, `OPENSSL_*` may not be set by a podspec (they could carry flags that undo the restrictions): `runtime-lane-driver.test.mjs`. |
| Host process memory | Separate process; the heap is capped with `--max-old-space-size` (a memory limit test stops a runaway pod). |
| Other pods | Other pods are other processes; they share the host user and kernel. |
| Which code runs | Only a module from the host's catalog (names to absolute paths, own-property lookup); a podspec never supplies a path (`runtime-lane-driver.test.mjs`). |

### node: `worker_threads`

| Reach | Result |
| --- | --- |
| Everything | **Not defended**, and asserted as such so the documentation cannot drift: a worker-thread pod can read and write host files, open connections and start processes (`node-runtimes.test.mjs`, "NOT DEFENDED"). It shares the host process's memory. Only the environment (`env` option) and the heap limit are applied. The placement planner gives `none`-boundary hosts only to requesters the operator trusts (`pod-placement.test.mjs`). |

### isolate: `isolated-vm` runtime

One V8 isolate per pod, inside the host's own Node process. The boundary is
V8's: a pod is JavaScript with its own heap and global object and nothing else.

| Reach | Result |
| --- | --- |
| Host files, network, processes | The isolate has none of `require`, `process`, `Buffer`, `fetch`, `setTimeout` and the other timers, `WebAssembly` (removed: its memory is not counted against the heap limit) or dynamic `import()`; a hosted module that statically imports anything is refused at start. Denied, tested: `isolate-runtime.test.mjs`, "no ambient authority". |
| Environment variables | Only the podspec's `env`, delivered as JSON data (`ctx.env`, frozen); the host's environment is not reachable. The driver still refuses `NODE_*`, `LD_*`, `DYLD_*`, `UV_*`, `OPENSSL_*`. |
| Host objects | None is handed in. Exactly two values enter an isolate, as arguments of a host-written wrapper function and never as globals: a JSON string, and one synchronous `ivm.Callback` that takes a string and returns `undefined` (the log line). Requests go in as JSON text, replies come back as JSON text of a bounded size, log text is bounded and its sink is called from a microtask, outside the isolate's callback. No `Reference`, `ExternalCopy` or host function is given to pod code, and no value from the pod reaches a host function except a string. Tested: constructor chains and a property-and-prototype walk from every value the pod holds, a thenable given to the callback, host subscribers that re-enter or drain the pod from inside the log event, a pod that rewrites its own `JSON`. |
| Memory | The pod's `limits.memMib` becomes the isolate's heap limit (floor 8 MiB). V8 enforces it as a guideline: upstream documents that a determined pod can reach 2 to 3 times the limit before it is stopped. A breach disposes only that isolate and is reported (`oom`). Tested with arrays and with a larger limit that the same allocation passes. Not covered: memory used outside the isolate by the addon, and the host's own memory pressure while a pod runs. |
| CPU and time | Every call into the pod (loading, `start()`, each request) has a wall-time limit enforced by the isolate (`limits.timeoutMs` for requests): a tight loop in the first segment, after an `await`, in the microtask queue, a regular expression run-away and `Atomics.wait` are stopped, tested. A breach disposes the isolate and is reported (`timeout`). A call that is waiting on a promise nothing can resolve is stopped by a host timer. Not covered: there is no cumulative CPU budget per pod, and a running pod uses one thread of the host's thread pool for as long as the limit allows. |
| Other pods | Separate isolates (separate heaps) in one process. A breach in one leaves the others running (tested). Pods share the process, the thread pool and the CPU caches. |
| Which code runs | Only a module from the host's catalog (read by the host, compiled as the sole dependency of a host-written wrapper). |

What a V8 or `isolated-vm` memory-safety bug means here: the isolate is not a
process boundary, so a bug in V8 or in the addon that lets pod code write
outside its heap is a bug in the **host process**: it runs with everything the
host process can read or do (its files, keys, credentials, network and every
other pod's memory). The upstream README says to keep isolates in a separate
process from anything critical. This runtime does not do that by itself, so
the host running it should hold nothing worth stealing, and the planner places
requesters of low trust on it only if the operator accepts that risk; a
hardware boundary (the microVM lane) is the stronger choice for strangers.
Keeping Node current matters: V8 fixes arrive through Node releases.

### isolate: Worker / Durable Object (the spike)

Requester code does not run: the Durable Object boots a fixed echo pod and
`run.ref` is not loaded. What a pod can reach is therefore what that fixed
code can: nothing on a host filesystem (there is none), outbound WebSocket to
the relay and signaling URLs it is configured with, the Worker's bindings
(`RELAY_URL`, `SIGNALING_URL`, `DISCOVERY_CHANNEL`, `CONTROL_TOKEN` when set)
and the Durable Object's storage, which holds the pod's identity key.
Before running requester code here, bindings and storage must not be visible
to it (one isolate per trust domain; `isolated-vm`/`workerd` runtimes are
specified, not built). The control routes are loopback-only in the shipped
self-hosting config and take an optional bearer token (`routes.test.mjs`).

### browser lanes

| Driver | Reach |
| --- | --- |
| in-page (`createInPageDriver`) | A child `<iframe>` / window / worker at a `podUrl` the host chose. **No sandbox attribute is set** (an opaque origin could not join the `BroadcastChannel` discovery). A same-origin pod shares the origin's cookies, storage and IndexedDB with its parent; a cross-origin one does not. Documented in the driver: this is not a privilege boundary. Not tested as a denial (there is none). |
| CDP (`spikes/browser-pod-host`) | A page in a browser the operator drives, one `BrowserContext` per pod when `contextPerPod` is set (separate cookies and storage). The page has the browser's network position (the host's loopback and LAN are reachable as far as the browser allows). Fake-CDP tested; one e2e test uses a real headless Chrome. |
| extension (`spikes/browser-extension-host`) | A tab plus a content script and a MAIN-world bootstrap with the extension's own permissions (`host_permissions` scoped). Tested against a fake only. |

## 2. Across all lanes: the control plane and the service

- **Scopes are per resource, not per pod.** `checkAccess(pubKey, resource, verb)`:
  a requester granted `drain`, `exec` or `send` on a resource can use them on
  any pod under it, including another requester's. Tenants are kept apart by
  giving each its own resource (README, "Gating"). Not changed.
- **What a requester reads of another's pod** is limited: `env` values and
  `run.input` are redacted for everyone but the spawner (#297).
- **`describe()` is ungated** by design (it reveals only what the host
  announces anyway).
- **Audit.** Placement records (`placement_requested`, `_denied`, `_started`,
  `_ready`, `_evicted`) are written by the host; a failure to write one does
  not fail the verb.
- **Admission** is the orchestrator's job (`pod-placement.mjs`): pods, vcpus,
  MiB, per-requester quota, and an untrusted requester is only placed behind a
  language or hardware boundary.

## 3. Defects found by this review, and what changed

Each has its own pull request and is described there by the behaviour it
establishes.

| Where | Behaviour established | PR |
| --- | --- | --- |
| `spikes/vm-pod-host` | each pod boots its own disk image; the VMM is stopped by recorded pid after an exact id check; the jailer never drops to uid or gid 0 (a distinct identity per VM); host network policy is per pod and default-deny; a failing host command stops the boot; interface names are hashed; the jailer runs under it with chroot-relative paths | #282, #293 |
| `spikes/isolate-pod-host` | control routes listen on loopback and accept a bearer token | #294 |
| `packages/browsermesh-apps` | `env` values and `run.input` are visible only to the spawner | #297 |
| `spikes/vm-pod-host` | `putDrive`/`putNetworkInterface` were sent with their arguments in the wrong shape (a correctness bug, not a security one) | #293 |

## 4. Not defended

- **Hypervisor, kernel and V8 vulnerabilities.** A KVM or Firecracker escape,
  a V8 zero-day, a Node permission-model bypass. The boundary is as strong as
  the component, and none of them is audited here.
- **Side channels** between guests or isolates on shared cores or in one
  process (Spectre-class, cache, timing).
- **The host operator.** The operator can read guest memory, snapshot files
  (which contain the guest's identity key and whole memory), a Durable
  Object's storage and every pod's key. A hosted pod's signature proves "this
  pod or its host" (`docs/hosted-pods.md` section 7).
- **Restoring one snapshot twice** creates two pods with one identity. Nothing
  prevents it yet.
- **Resource exhaustion** beyond what is configured: a pod that floods an
  *allowed* destination; disk space in a pod's own image; the number of
  threads in a worker; a `worker_threads` or permission-model pod's CPU use
  (only memory is limited).
- **Within one resource, another requester's pod** can be drained, executed
  in or messaged by a requester holding the verb (section 2).
- **`worker_threads` pods** reach everything the host can; **permission-model
  pods** share the host's user and kernel and Node documents the model as a
  safeguard, not a sandbox against hostile code.
- **In-page browser pods** share the host page's origin if served from it.
- **The guest has no resolver** by default, and `caps` and `limits.timeoutMs`
  are not enforced by the microVM driver.
- **Requester code in the `workerd` isolate spike** is not run at all today,
  so nothing is claimed about running it. The `isolated-vm` runtime does run
  catalog modules; see its section above for what that does and does not
  protect (it is a V8 isolate in the host's process, so a V8 bug is a host
  bug).
- **Anything that depends on a real Linux/KVM host** (the jail, the nft rules,
  the guest) is unverified.

## 5. Where each denial is tested

| Denial | Test |
| --- | --- |
| a pod cannot read, write, connect, spawn (permission process) | `packages/browsermesh-pod/test/node-runtimes.test.mjs` |
| `worker_threads` pods can (documented gap) | same, "NOT DEFENDED" |
| pods only see their own environment | same, "environment"; `runtime-lane-driver.test.mjs` |
| a podspec cannot name a module path or loader/limit variables | `runtime-lane-driver.test.mjs` |
| an isolate-lane runtime must have a language or hardware boundary | `runtime-lane-driver.test.mjs` |
| isolate pods have no ambient authority, no host object, and are stopped on memory or time breach | `packages/browsermesh-pod/test/isolate-runtime.test.mjs` |
| untrusted requesters are not placed on weak boundaries | `packages/browsermesh-apps/test/pod-placement.test.mjs` |
| each microVM has its own disk, VMM identity and network rules | `spikes/vm-pod-host/test/*.test.mjs` |
| the isolate control plane refuses requests without the token | `spikes/isolate-pod-host/test/routes.test.mjs` |
| a requester cannot read another's env values or input | `packages/browsermesh-apps/test/pod-host-service.test.mjs` |
| the guest cannot reach the metadata address or the host (real host) | `spikes/vm-pod-host/test/real/firecracker.real.test.mjs` (never run) |
