# @johnhenry/browsermesh-egress

## 0.1.0

### Minor Changes

- 3e5fcdd: A new package: a pod lends its network access to peers that hold a grant.

  `createMeshEgress({ service, registry, dial, resolve, sets?, wide?, blockedPorts?, limits?, onAudit?, onMeter?, ... })` is the provider: off until `start()` (which needs an `indicator` or `unattended: true`), it serves a new protocol `egress` (version 1) on the protocol channel to the peers that hold `protocol:egress:open`, and for each request asks its registry about that destination: `egress:tcp:<host>:<port>:connect`, `egress:tcp:<host>:*:connect`, `egress:set:<name>:connect` (operator-written sets of exact hosts, `*.suffix`, IPv4 blocks and port lists) and, for a name lookup, `egress:dns:<name>:resolve`. `connectEgress(service, providerPodId)` is the consumer (browser-safe: no `node:` import): `link.connect(host, port)` resolves with a netway `StreamSocket` (half-close, backpressure end to end), `link.lookup(name)` returns IPv4 addresses and tells a name that does not exist from a failure, and `link.asBackend()` is a netway `Backend` for `VirtualNetwork.addBackend('tcp', ...)`.

  - The address a destination resolves to is checked after resolution, by wsh's address guard (`@johnhenry/wsh/address-guard`, 0.55.0) behind the `dial` and `resolve` options (`nodeDialer()` on `@johnhenry/browsermesh-egress/node`): resolved once, every answer classified, the checked address dialled. Private, loopback, link-local, unique-local, carrier-NAT and metadata space stay refused; only the operator's `allowPrivate`, for destinations a grant names, admits private space, and a peer's grant never does. A name whose answers mix a permitted and a refused address is refused whole.
  - Nothing is on by default. A wildcard grant is refused (`wide-not-acknowledged`) unless the operator wrote `wide: { acknowledge: 'any-public-address' }`, and then reaches public destinations only. Mail submission ports (25, 465, 587) are blocked, and stay blocked in wide mode.
  - Budgets, each named in its refusal or end reason: connections per consumer (16) and in all (64), connection attempts per minute (120 per consumer, 600 in all), lookups per minute (30), 64 MiB per connection, 1 GiB per consumer per 24 hours, 15 s to connect, 5 min idle, 1 h total. Revoking a grant ends that consumer's live connections at once. No chaining through a second egress. `onAudit` (who, destination, address class, bytes each way, duration, outcome; never contents) and `onMeter` (the same counts without a destination).
  - Stable refusal codes, exported as `REFUSAL_CODES`, `BUDGET_NAMES`, `END_REASONS` and `LINK_CODES` and listed in the README.

  Not in this version yet: the fetch form, UDP, a command-line provider and the browser spec. Nothing on the wire changes for existing packages: a peer that does not serve `egress` answers the open with `unknown-protocol` and is sent nothing else.
