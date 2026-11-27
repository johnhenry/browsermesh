---
"@johnhenry/browsermesh-mcp": minor
---

MCP over the mesh now speaks the 2026-07-28 revision as well as the legacy `initialize` one. The serving side answers `server/discover` (versions, `tools` capability only, no tool names), serves requests that carry per-request `_meta` statelessly (an unknown version gets `UnsupportedProtocolVersionError`, -32022), tags results with `resultType` and gives `tools/list` its caching hints, announces tool-list changes on `subscriptions/listen`, and always lists tools in name order; nothing in `_meta` is read for authorization. The typed client's `initialize()` probes modern first and falls back to legacy (`initialize({ era })` overrides, `client.era` reports), and a `@modelcontextprotocol/client` 2.x `Client` connects through `MeshMcpTransport` in either mode. A peer that only ever spoke modern is no longer sent `closeSessions`'s `notifications/message` teardown notice. No wsh release is needed and the wsh peer floor is unchanged.
