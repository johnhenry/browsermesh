---
"@johnhenry/browsermesh-apps": patch
---

Bind pending mesh RPC responses to the intended transport peer. A matching request ID from another peer can no longer complete the call. Reject calls after teardown and settle failed sends without leaving an unobserved pending promise.
