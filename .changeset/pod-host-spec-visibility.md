---
"@johnhenry/browsermesh-apps": patch
---

The pod host service returns a pod's `env` values and `run.input` only to the requester that spawned it. Other requesters allowed to `status` or `list` the pod still see its name, state, module, limits, labels and the env variable names, with the values and the input replaced by `"[redacted]"`; a pod the service did not spawn is redacted for everyone. Existing clients that spawn a pod and read it back are unaffected.
