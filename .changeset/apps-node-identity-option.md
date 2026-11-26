---
"@johnhenry/browsermesh-apps": minor
---

`createMeshNode({ identity: { podId } })` adopts an identity that already exists in the supplied `identityManager` instead of creating a new one, so a page can keep its key across a reload. It throws if the pod id is not in the manager, if no `identityManager` is given, or if the option is malformed. The adopted identity becomes the manager's default (what `node.podId` reports). Without the option nothing changes.
