---
"@johnhenry/browsermesh-egress": minor
---

Add the fetch form, UDP and a command line to the egress package. Everything is additive on protocol `egress` version 1: a
0.1.1 consumer is answered exactly as before, and a 0.1.1 provider answers the two new request methods method-not-found, which
this consumer reports as `provider-no-form`.

- `link.fetch(input, init)`: a fetch-shaped call that returns a `Response`, for what CORS blocks. The provider is the HTTP
  client, so it sees the request and the response in plaintext; the form has its own scope per destination origin
  (`egress:http:<host>:<port>:fetch`, `egress:http:<host>:*:fetch`, `egress:set:<name>:fetch`) and is offered only when the
  provider is given an `exchange` (`nodeDialer().exchange`). Redirects are followed by the provider only to destinations the
  consumer also holds a fetch grant for, and each hop is address-checked again; headers are allow-lists in both directions;
  GET and HEAD by default (`fetchMethods`); the body is streamed with backpressure; new limits `maxFetchRequestBytes` (1 MiB),
  `maxFetchResponseBytes` (8 MiB), `maxFetchDurationMs` (30 s), `maxRedirects`, `maxHeaderBytes`, `headersTimeoutMs`; the audit
  carries the length of the path and query, and `auditUrls: 'path' | 'full'` adds them.
- `link.udp(host, port)`: one flow per destination (`egress:udp:<host>:<port>:send`, `egress:udp:<host>:*:send`,
  `egress:set:<name>:send`) over a datagram socket connected to the address that was checked (`nodeDialer().dialUdp`). Per-flow and
  per-consumer budgets (datagrams, bytes, idle, rate), replies bounded by what the consumer sent, port 53 refused for every
  grant (`blockedUdpPorts`), silent drops counted in `stats().udp`.
- `browsermesh-egress`: a command that runs a provider from a JSON grants file (`--allow`, `--set`, `--dry-run`, an audit line
  per event); wide mode needs `--wide --acknowledge-wide any-public-address` and cannot be turned on from the file.
- `nodeDialer()` now also returns `dialUdp` and `exchange` (and takes `ca` for the fetch form's `https:`).
- New refusal codes `bad-url`, `method-not-allowed`, `redirect-refused`, `too-many-redirects`, `bad-response`, `not-offered`, link
  codes `provider-no-form` and `datagram-too-large`, budget names `fetch-request-bytes` and `udp-flows-per-consumer`, end reason
  `datagram-budget`.
