---
'@johnhenry/browsermesh-transport': patch
'@johnhenry/browsermesh-meshctl': patch
---

Concurrent dialers against one host no longer run past their timeout (#431).

- `WshPeerLinks` dialling: a dial the relay closes at once because no host half is waiting for it (every half at the host's rendezvous id is taken while the host refills) is now retried with jittered backoff inside `connectTimeoutMs`, so a burst of operators is served as the host refills its halves instead of failing `WSH_UNREACHABLE`. The whole dial, retries included, stays within `connectTimeoutMs`.
- `meshctl --wsh-relay`: `--timeout` now also bounds the dial (it is passed as `connectTimeoutMs`). Before, only each request used it and the dial waited the link layer's 15 s default, so a dialler held at the relay outlived `--timeout`. An explicit `wsh: { connectTimeoutMs }` still wins.
