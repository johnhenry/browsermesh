---
"@johnhenry/browsermesh-transport": minor
---

Add `WshServices`: a stock wsh client may use a pod's objects and MCP tools. Off unless the embedder constructs and starts it; it listens at its own rendezvous id, apart from the mesh link host, as a sealed wsh host that serves only the `mcp` and `wsh-objects` rpc channels. A key is admitted only by the pod's registry grants for its pod id (`wsh-services:open`, then `protocol:mcp:open` / `protocol:objects:open`, then per request `mcp:<tool>:list|call` and `objects:<root>:get|call|set|on`); a revocation or an expiry ends the session. The mesh link host is unchanged. Needs `@johnhenry/wsh` 0.48 or later when started.
