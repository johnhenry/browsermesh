# @johnhenry/browsermesh-egress

## 0.3.2

### Patch Changes

- 4af3c21: The READMEs now say these packages are tested against `@johnhenry/wsh` up to 0.57.0. Nothing in the code of these four changed and every peer range is unchanged: none needs the half-close rule that 0.57 added. The egress package gained tests for a consumer that finishes sending and keeps reading (an answer two seconds later, a large one, a destination that finishes first, both sides finishing, a silent half-closed consumer ended by `idleMs`), and its README says what bounds a half-closed connection; the transport's wsh link ends when it reads the peer's end of stream, and a test now pins that.

## 0.3.1

### Patch Changes

- 34687ff: The README no longer lists "an adapter example" as not built: `examples/local-listener.mjs` (in the repository) is a Node consumer that listens on a loopback port and carries each connection through `connectEgress` to a granted destination, with a grants file for the `browsermesh-egress` command. Documentation only; nothing in the package's code changed.

## 0.3.0

### Minor Changes

- b2144a1: What the first real consumer (a container engine in a browser tab) found, issue #379. Protocol `egress` is still version 1 and
  everything is additive or negotiated: a 0.1.1 or 0.2.0 peer is answered exactly as before, and an older peer is never sent a
  message it would mis-handle (the README has the table of what an older peer does for each change).

  - **Response headers.** The fetch form's response allow-list adds `www-authenticate`, `link`, `docker-distribution-api-version`,
    `docker-content-digest` and the `ratelimit-*` / `x-ratelimit-*` headers (still bounded in count and size; never `set-cookie`).
    A header that carries a URL the consumer will act on is the provider's word; the consumer's request to it needs its own grant.
  - **Names and addresses.** New `connectByResolvedAddress` provider option (off by default): a `connect` to an address the
    provider's OWN lookup returned for that consumer, under its `dns` grant, for `addressMemoryMs` (10 minutes) and at most
    `maxRememberedAddresses` (256) per link, is decided by the consumer's TCP grant for the name; it is dialled as it is, through
    the same address guard, with no second lookup. New `mapAddresses` consumer option (off by default) and `createAddressMemory`:
    works against any provider by asking for the name when an address is refused `no-grant`.
  - **Liveness.** A `ping` request on the channel from each end (every 5 s; gone after 3 silent intervals, so about 15 s; set with
    `keepAlive: { intervalMs, misses }` or `false`), answered `{ ok: true }`. An older peer answers method-not-found, which counts as
    an answer. A dead provider ends the consumer's link `provider-gone` and everything open with that code; a dead consumer's channel
    is closed and its connections and budgets freed (`egress-consumer-gone` in the audit, `gone` in `stats()`). The link has
    `closeReason`, `whenClosed` and `onClose(cb)` with the reasons in `CLOSE_REASONS` (`closed` stays a boolean).
  - **A browser entry.** `@johnhenry/browsermesh-egress/browser`: `createEgressNode({ signaling })` and `node.connect(providerPodId)`
    build the identity, the signalling connection and a lean mesh node (about 267 kB minified instead of about 1.46 MB for the apps
    package root recipe; a test bundles it and pins the size). It needs `@johnhenry/browsermesh-apps` `>=0.25.0`. The package is
    marked `sideEffects: false`.
  - **Open failures.** New link codes `provider-not-found`, `provider-refused` and `signalling-unreachable` (and `provider-gone`);
    `provider-unreachable` stays the catch-all for what none of them names.
  - **Docs.** README: installing for a page that only consumes (what `engines`, `node-datachannel` and `isolated-vm` bring and how to
    leave them out), a worked example of grants for pulling from public registries through the fetch form, names and addresses,
    liveness, compatibility with 0.2.0, and that UDP in a guest kernel's network backend is upstream.

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
