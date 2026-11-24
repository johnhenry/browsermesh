---
"@johnhenry/browsermesh-mcp": minor
---

New package: a page's WebMCP tools (or an explicit tool list) served over a browsermesh protocol channel (`serveMcpOnMesh`), and a client and MCP transport for them (`openMcpOnMesh`, `connectMcpOnMesh`, `MeshMcpTransport`). Per-tool `mcp:<tool>:list` and `mcp:<tool>:call` grants through the node's registry (default deny, checked on every request), the approval of consequential tools kept with the serving page, bounds by name, results labelled untrusted, cancel reaching the tool's signal. Peer-depends on `@johnhenry/wsh` (the WebMCP bridge) and `@johnhenry/browsermesh-apps`.
