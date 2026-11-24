---
'@johnhenry/browsermesh-transport': patch
'@johnhenry/browsermesh-primitives': patch
'@johnhenry/browsermesh-netway': patch
---

Adopt `@johnhenry/wsh` 0.49.0.

- transport: `WshServices` starts a session (audit, `sessions`, indicator) when wsh reports the session sealed, not at login. A plain client that passes login on the sealed-only host was audited as a session and shown to the person although it was served nothing; now it is only a `refused` audit. The per-tool grants go through wsh's `permits` hook (`mcp-tool` for listing, `mcp-call` for running) instead of a wrapper around the handler, and the duplicate calls-per-minute count is gone (wsh's own bound applies). `WshServices` needs wsh 0.49 or later (the rest of the package still works from 0.45); results carry wsh's `wsh/untrusted` label only. The tests use `@johnhenry/wsh/testing`'s in-process relay; the `wsh-in-process` subpath is unchanged.
- primitives: no behaviour change. `ssh-keys.mjs` is now run against `@johnhenry/wsh/identity` in a test (valid inputs, strictness cases and the written differences).
- netway: no behaviour change. `GATEWAY_ERROR` is checked against wsh's exported `GATEWAY_FAIL_TABLE` and its doc says code 5 is a timeout in the Node gateway and "gateway disabled" in the Rust server.
