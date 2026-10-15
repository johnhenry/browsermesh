---
"@johnhenry/browsermesh-transport": patch
---

Preserve FIFO delivery when jitter timer callbacks fire out of order under load. Readiness now drains a send queue rather than allowing each timer to send independently; closing clears the queue and all timers.
