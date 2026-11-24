---
"@johnhenry/browsermesh-apps": minor
"@johnhenry/browsermesh-pod": minor
---

Hosted pods have owners. Within one `pod-host` resource, `send`, `exec`, `snapshot`, `restore` and `drain` on an existing pod now need the requester to have spawned it through the service or to hold an explicit grant on the pod itself (`<resource>/<name>:<verb>`); the verb on the resource alone no longer reaches another requester's pod. `status` of another's pod stays redacted and no longer registers interest in its events. A pod the service did not spawn has no owner and needs such a grant. Callers that only use pods they spawned are unaffected; a deployment that relied on one identity driving another's pods must grant on the pod. `InMemoryPodHostDriver` now refuses (`ELANE`) a podspec for another lane than its own unless constructed with the test option `acceptAnyLane: true`.
