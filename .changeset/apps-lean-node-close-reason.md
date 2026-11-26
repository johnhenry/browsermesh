---
"@johnhenry/browsermesh-apps": minor
---

Two additions, both additive.

- `@johnhenry/browsermesh-apps/lean-node`: `createLeanMeshNode(options)`, the smallest connected node (identity, a default-deny
  registry, WebRTC and signalling, no services), for a page that only has to reach one pod. It takes the options of
  `createMeshNode` that mean the same thing and returns the same kind of node; `attachService` and `createMeshProtocolService`
  are re-exported from it. Its static imports are named, so a bundler keeps a fraction of what the package root pulls in. The
  package root and `createMeshNode` are unchanged.
- A protocol channel closed with a short plain-text reason tells the other end why: the `mesh.protocol.close` notification carries
  an optional `reason`, and the other end reads it as `channel.remoteReason`. A peer that predates the field ignores it.

Also fixes the WebRTC negotiator leaving a timer waiting for an answer to an offer that never left (the signalling transport threw
while sending it): the wait is now cancelled.
