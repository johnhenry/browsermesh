# @johnhenry/browsermesh-egress

## 0.2.0

### Minor Changes

- 6c78ae8: Add the fetch form, UDP and a command line to the egress package. Everything is additive on protocol `egress` version 1: a
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

## 0.1.1

## 0.1.0

### Minor Changes

- 3e5fcdd: A new package: a pod lends its network access to peers that hold a grant.

  `createMeshEgress({ service, registry, dial, resolve, sets?, wide?, blockedPorts?, limits?, onAudit?, onMeter?, ... })` is the provider: off until `start()` (which needs an `indicator` or `unattended: true`), it serves a new protocol `egress` (version 1) on the protocol channel to the peers that hold `protocol:egress:open`, and for each request asks its registry about that destination: `egress:tcp:<host>:<port>:connect`, `egress:tcp:<host>:*:connect`, `egress:set:<name>:connect` (operator-written sets of exact hosts, `*.suffix`, IPv4 blocks and port lists) and, for a name lookup, `egress:dns:<name>:resolve`. `connectEgress(service, providerPodId)` is the consumer (browser-safe: no `node:` import): `link.connect(host, port)` resolves with a netway `StreamSocket` (half-close, backpressure end to end), `link.lookup(name)` returns IPv4 addresses and tells a name that does not exist from a failure, and `link.asBackend()` is a netway `Backend` for `VirtualNetwork.addBackend('tcp', ...)`.

  - The address a destination resolves to is checked after resolution, by wsh's address guard (`@johnhenry/wsh/address-guard`, 0.55.0) behind the `dial` and `resolve` options (`nodeDialer()` on `@johnhenry/browsermesh-egress/node`): resolved once, every answer classified, the checked address dialled. Private, loopback, link-local, unique-local, carrier-NAT and metadata space stay refused; only the operator's `allowPrivate`, for destinations a grant names, admits private space, and a peer's grant never does. A name whose answers mix a permitted and a refused address is refused whole.
  - Nothing is on by default. A wildcard grant is refused (`wide-not-acknowledged`) unless the operator wrote `wide: { acknowledge: 'any-public-address' }`, and then reaches public destinations only. Mail submission ports (25, 465, 587) are blocked, and stay blocked in wide mode.
  - Budgets, each named in its refusal or end reason: connections per consumer (16) and in all (64), connection attempts per minute (120 per consumer, 600 in all), lookups per minute (30), 64 MiB per connection, 1 GiB per consumer per 24 hours, 15 s to connect, 5 min idle, 1 h total. Revoking a grant ends that consumer's live connections at once. No chaining through a second egress. `onAudit` (who, destination, address class, bytes each way, duration, outcome; never contents) and `onMeter` (the same counts without a destination).
  - Stable refusal codes, exported as `REFUSAL_CODES`, `BUDGET_NAMES`, `END_REASONS` and `LINK_CODES` and listed in the README.

  Not in this version yet: the fetch form, UDP, a command-line provider and the browser spec. Nothing on the wire changes for existing packages: a peer that does not serve `egress` answers the open with `unknown-protocol` and is sent nothing else.
