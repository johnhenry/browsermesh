---
"@johnhenry/browsermesh-apps": minor
---

Link admission: `createLinkAdmission({ maxRestricted, deadlineMs, maxFrameBytes, decide, handler, onEvent })` (a restricted state for links whose peer is not yet known: cap, deadline, one-shot promote/close, frame cap, counters) and `createWshAdmissionAuthorize`. `createMeshNode({ admission })` gates inbound WebRTC sessions through `decide` (reporting `proven: false` for a link whose key the identity binding did not verify) and, with `wsh`, admits unknown wsh peers to a restricted link; `node.admission` is the seam. Opt-in: without the option nothing changes.
