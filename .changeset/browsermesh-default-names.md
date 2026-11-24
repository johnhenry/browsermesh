---
"@johnhenry/browsermesh-core": patch
"@johnhenry/browsermesh-embed": patch
"@johnhenry/browsermesh-transport": patch
"@johnhenry/browsermesh-discovery": patch
---

Defaults that still carried the project's earlier name now use `browsermesh`: the default identity's display and full names (the earlier short aliases stay), the embed widget's default container id (`#browsermesh`; an existing `#clawser` element is still found when `#browsermesh` does not exist, and an explicit `containerId` is never replaced) and the channel relay's default sender. The `ChannelRelay` BroadcastChannel name and the discovery SharedWorker name keep their earlier values on purpose, because they are rendezvous points between pages that may run different releases; both are documented in the code.
