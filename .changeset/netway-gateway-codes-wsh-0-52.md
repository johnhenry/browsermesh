---
'@johnhenry/browsermesh-netway': minor
'@johnhenry/browsermesh-mcp': patch
'@johnhenry/browsermesh-objects': patch
'@johnhenry/browsermesh-transport': patch
---

Follow wsh 0.52.0's numbering of the gateway failure codes. In netway's `GATEWAY_ERROR`, `TIMEOUT` is now `8` and
`GATEWAY_DISABLED: 5` is new (the rest are unchanged: 1 to 4, `CLOSED` 6, `QUEUE_FULL` 7). `GatewayBackend` throws a
received 8 as an `OperationTimeoutError`, like its own operation timeout. A received 5 is read as "the gateway is
disabled, or a timeout from an older gateway" and its `ConnectionRefusedError` says so, because the Rust server has
always sent 5 for a disabled gateway and a Node gateway at wsh 0.51.0 or earlier sent 5 for a timeout. netway itself
sends no failure code. Compatibility: a netway peer on the previous version reads an 8 from a gateway as a code it does
not know (it throws a `ConnectionRefusedError` with the host's message and `(code: 8)`, no more), and a peer on the
previous version, and a gateway at 0.51.0 or earlier, still use 5 for a timeout, which the new version reads as
described above (netway has no code of its own to send, so the only senders are gateways).
`browsermesh-mcp`, `browsermesh-objects` and `browsermesh-transport` are tested against wsh 0.52.0 (documentation only).
