---
"@johnhenry/browsermesh-transport": minor
---

`WshPeerLinks`: `authorize` may return `{ restricted: true }`, and a new `admission` option takes a seam (`admit({ peerKey, transport, proven, channel })`). A restricted peer is logged in with `endpoint:mesh-admission` instead of `endpoint:mesh`, its link is not a peer (no `peer-up`, no `message`) and its frames go to the seam until `adopt()` promotes it. A dialler whose `mesh` endpoint is refused by policy opens `mesh-admission`. `true`, `false` and `{ expires }` verdicts and the default (nobody) are unchanged. See `docs/design/link-admission.md`.
