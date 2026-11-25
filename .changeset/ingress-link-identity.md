---
'@johnhenry/browsermesh-ingress': minor
---

The provider's and the ingress's hooks are told what is verified about the link a request came over, and a helper binds a request's signer to that link.

- `serveHttpOnMesh`: `allowFrom` (when a function) and `verifyRequest` get one more, trailing argument, a `peer` object `{ podId, verified, keyId?, publicKey? }`. `verified` is `'bound'` (a direct WebRTC connection whose peer proved the key behind its pod id), `'wsh'` (a wsh peer link), `'key'` (both at once) or `'none'` (nothing was proven: an unbound WebRTC connection, a relayed or otherwise vouched-for link, any other transport, or no node given). `keyId` (the pod id, the hash of the key) and `publicKey` are present only when something was proven. The existing context objects and their `peer` string are unchanged, so a hook written for the old shape is called exactly as before.
- Where the link's identity is read from: `serveHttpOnMesh(..., { node })` (a `createMeshNode` result; `nodeLinkIdentity(node)` is exported) or your own `linkIdentity(podId)`. With neither, `verified` is always `'none'`: nothing is guessed. A source can only narrow, and a node counts a link as proven only when every live session to the pod proves it.
- `requireLinkKey(verifySigner)`: a ready-made `verifyRequest` that accepts a request only when the link proved a key and the key that signed the request (the verified key or key id your `verifySigner` returns) is the link's key. A refusal is the existing `request-unverified` one and its reason (`link-unverified`, `signer-unverified`, `signer-key-invalid`, `link-key-mismatch`) goes to `onLog` and `stats().refusals`. Off unless used.
- `createMeshIngress`: `signRequest` and `verifyResponse` get the same `peer` object for the provider's link as a trailing argument (`linkIdentity`, or a `node` that is a mesh node); `requireLinkKey` works for `verifyResponse` too.
- Type declarations (`src/index.d.ts`, `src/node.d.ts`) are now shipped.

Nothing on the wire changes and an older peer is unaffected.
