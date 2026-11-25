---
'@johnhenry/browsermesh-pod': minor
'@johnhenry/browsermesh-apps': minor
---

Hosted pods can sleep and wake by use (cold boot as sleep). `@johnhenry/browsermesh-pod` adds `createHibernatingDriver(innerDriver, opts)`, a `PodHostDriver` wrapper: a pod idle for `idleMs` is drained to a record in a `HibernationStore` (podspec and `podId`) and reports `state: 'cold'` with `sleeping: true`; a `send`, `exec` or `deliver()` boots it again within `wakeTimeoutMs`, concurrent callers sharing one boot in order, bounded by `maxQueuedPerPod` and `maxConcurrentWakes`. A sleep sends no `exit` event, so a supervisor restarts nothing; `status`, `list` and `drain` never wake a pod; a wake fails rather than bring up a pod with a different `podId`. `PodHostDriver.spawn(spec, options)` takes an optional second argument (`{wake: {discoveryWindowMs}}`) that drivers may ignore. Also exports `MemoryHibernationStore`, `HIBERNATION_DEFAULTS`, `HIBERNATION_REASON` and `WAKE_FAILURE`.

`@johnhenry/browsermesh-apps`: a pod-host `describe()` now carries `hibernation` (the host's policy, or `null`); `createHostPool({ overcommitSleeping })` (default `false`, which changes nothing) lets a sleeping pod free its cpu and memory in the ledger while still counting as a pod and toward the requester quota, and refuses a wake that would not fit (`EBUSY`, `wake-refused`).

Nothing is on by default and nothing on the wire changes except the optional `sleeping`/`waking` status fields and the `hibernation` description field; an older client ignores them and sees a sleeping pod as `cold`. Not run against a real Durable Object.
