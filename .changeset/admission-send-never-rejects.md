---
"@johnhenry/browsermesh-apps": patch
---

A restricted link's `send()` (link admission) returns a promise that never rejects: `true` once the transport accepted the frame, `false` if the transport failed or the link is closed, including a send after the deadline or after the peer left. A handler that fires and forgets a send no longer risks an unhandled rejection when the link closes. Programmer errors (a send after `promote()`, a frame over `maxFrameBytes`) still throw synchronously.
