# browsermesh-egress

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Fbrowsermesh-egress.svg)](https://www.npmjs.com/package/@johnhenry/browsermesh-egress)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Fbrowsermesh-egress.svg)](LICENSE)

A pod lends its network access to peers that hold a grant. A peer that cannot reach the open network (a browser tab: no
raw sockets, bound by CORS) asks a pod that can (Node, or anywhere with sockets) to open a TCP connection to `host:port`,
to send UDP datagrams to one, to look a name up, or to fetch an `http(s)` URL, and gets the answer back. The mirror of
[`browsermesh-ingress`](../browsermesh-ingress): ingress brings HTTP in to a pod, egress takes the network out from one.

It is a library: `createMeshEgress` (the provider), `connectEgress` (the consumer, browser-safe, with a netway backend),
on its own Node entry `nodeDialer` (the provider's network, on wsh's address guard), a small browser entry
(`./browser`, `createEgressNode`: everything a page needs to reach a provider, about 270 kB minified instead of about
1.4 MB), and a command line, `browsermesh-egress`, that runs a provider from a grants file.

Peer dependencies: `@johnhenry/browsermesh-apps` `>=0.21.0` (the protocol channel and its streams; the `./browser` entry
needs `>=0.25.0`, which has `@johnhenry/browsermesh-apps/lean-node`) and
`@johnhenry/browsermesh-netway` `>=0.3.0` (the socket a consumer gets, and the backend). The provider's Node entry
(`./node`) also needs `@johnhenry/wsh` `>=0.55.0` (an optional peer dependency: its address guard,
`@johnhenry/wsh/address-guard`). The consumer entry imports no `node:` module and no wsh. Real WebRTC from Node needs
`node-datachannel` (an optional dependency). [Installing for a page](#installing-for-a-page-that-only-consumes) says what
a consumer-only install brings, and how to leave the provider's parts out.

## What it is, and what it is not

- **It is** a bounded way to lend a network: protocol `egress` v1 on the existing protocol channel
  (`openProtocol(peer, 'egress', { versions: [1] })`), TCP connections as two protocol streams each (credit-based
  backpressure, half-close, cancellation), UDP flows (datagrams as frames of two streams), name lookups as one request,
  and a fetch-shaped call.
- **It is not an open proxy.** Nothing is lent unless the operator created and started a provider, and then only to peers
  that hold a grant for the destination they ask for.
- **The TCP and UDP forms carry bytes, they do not read them.** There is no TLS code in those paths, no interception mode
  and no sniffing.
- **The fetch form is a different promise: the provider is the HTTP client, so it sees the request and the response in
  plaintext.** A page cannot terminate TLS on a raw stream, so for `fetch` the provider does it. A grant for it
  (`egress:http:...:fetch`) says "I trust this provider with this request and its answer", and the provider's operator should
  know that their machine reads it. Where a page can run its own TLS over `connect()`, that form is private from the provider;
  use it. See [The fetch form](#the-fetch-form).
- **It is not a VPN, a Wisp server or a SOCKS server**, and it does not run a wsh gateway for the peer.
- **Not in this version yet:** see [Not in this version yet](#not-in-this-version-yet).

## What running a provider means for you

Read this before you turn it on.

- **Your address is what destinations see.** Every connection a consumer opens comes from the provider's network
  address. Complaints, blocks and legal notices about what a consumer did go to whoever runs the provider. Do not run it
  from a connection you cannot afford to have blocked.
- **A grant is trust in a pod key, not in a person.** A key could be compromised. What a compromised key can do is
  bounded by the destinations you granted, the budgets and `expiresAt`: grant narrowly, for a short time, to a named peer.
- **You carry plaintext for plain protocols.** For TLS you see the destination, the sizes and the timing and nothing
  more; for a protocol with no TLS you carry everything a consumer sends. The audit never records contents, and the
  package logs none.
- **With the fetch form on, your machine reads what the consumer fetches.** The provider makes the HTTP(S) request itself,
  so it sees the URL, the headers (an `Authorization` the consumer sends, included), the request body and the response, in
  plaintext, and it could alter the response. The audit does not record them, but your process holds them. Give a fetch
  grant only to a peer you would trust with that, and tell the people whose requests you carry. The form is off unless you
  pass an `exchange` (`nodeDialer().exchange` does).
- **UDP carries whatever a consumer sends, to the one address it names**, from your address. The provider drops what it
  will not pass on, and bounds the replies a flow may receive by what it sent (below).
- **A granted destination that is itself a proxy, a VPN or a relay passes the consumer on** to whatever it forwards. Do not
  grant one you would not grant the whole network.
- **Destinations and timing are personal data in many places.** The audit has them; set your own retention.
- **Stopping the provider drops every connection.** There is no resume.

## Installing for a page that only consumes

A page needs the consumer half and the wiring to reach a provider; it never runs the provider, the command line or WebRTC from
Node. What `npm install @johnhenry/browsermesh-egress` brings, and what to do about it:

- **Node `>=26` in `engines`.** Every package of this family declares it (the provider and the command line need it), so the
  install prints an `EBADENGINE` warning on an older Node and, with `engine-strict`, stops. Nothing of it runs in the page:
  the bundle is plain ESM for a browser. Install on Node 26, or leave `engine-strict` off.
- **`node-datachannel`**: a native WebRTC binding, an `optionalDependency` (an install that cannot get it still succeeds). Only
  the command line and a provider in Node use it. A page never loads it.
- **`isolated-vm`**, through `@johnhenry/browsermesh-pod` (the page takes the signalling transport from it): an optional
  dependency of that package, which needs a native build when there is no prebuilt binary (with `--ignore-scripts` it is
  present and unbuilt, and nothing in a page imports it).
- **`@johnhenry/wsh`**: an optional peer, needed only by `./node`. It is not installed for you.

To leave the native parts out, omit optional dependencies and name what the page does need:

```
npm install --omit=optional @johnhenry/browsermesh-egress @johnhenry/browsermesh-apps @johnhenry/browsermesh-netway \
  @johnhenry/browsermesh-core @johnhenry/browsermesh-discovery @johnhenry/browsermesh-transport \
  @johnhenry/browsermesh-pod @johnhenry/browsermesh-primitives
```

(`--omit=optional` also leaves out the five `@johnhenry/browsermesh-*` packages the package lists as optional, which is why
they are named. `isolated-vm` is then not fetched at all.) A provider started without what it needs says so: `./node` throws
"needs @johnhenry/wsh 0.55.0 or later", and the command line exits with "WebRTC is not available: the optional dependency
node-datachannel is not installed" or names the BrowserMesh package it could not load, each with the command to run. The engines
field and the optional dependencies are left as they are: moving `node-datachannel` out of `optionalDependencies` would stop
`npx @johnhenry/browsermesh-egress` from having WebRTC, and the engines floor is the family's.

```js
import { createEgressNode } from '@johnhenry/browsermesh-egress/browser'

const egress = await createEgressNode({ signaling: 'wss://signal.example/signaling' })   // an identity, the signalling connection, a node
console.log(egress.podId)                                  // what the provider's operator grants `protocol:egress:open` and the destinations to
const link = await egress.connect(providerPodId)           // connects to that pod, opens protocol `egress`, pins the link to it
const res = await link.fetch('https://registry.example/v2/')
link.onClose(({ reason }) => console.log('the link ended:', reason))
await egress.close()
```

`createEgressNode({ signaling, identity?, label?, iceServers?, answerTimeoutMs?, openTimeoutMs?, onLog? })` takes the signalling
server's WebSocket URL (or a ready transport with `send(message)` and `onMessage(cb)`), an identity to restore
(`{ privateKeyJwk }`, from `egress.identityManager.export(egress.podId)`; keep it where the page keeps secrets, or the pod id
changes each load and so do the grants), and TURN servers for a provider behind a strict NAT. `connect(providerPodId, options)`
takes `connectEgress`'s options and rejects with an `EgressError` that says what to tell the person: `signalling-unreachable`,
`provider-not-found`, `provider-timeout`, `provider-not-authorized`, `provider-no-egress`, `provider-version`,
`provider-refused` ([the codes](#refusals-in-one-place)). The entry is the consumer half only: no provider, no `node:` module,
no wsh (a test bundles it with esbuild and pins its size; the old recipe, `createMeshNode` from the apps package root, was
1,463,032 bytes in the same measurement and this is 267,127).

## Library

```js
import { attachService, createMeshProtocolService } from '@johnhenry/browsermesh-apps'
import { createMeshEgress } from '@johnhenry/browsermesh-egress'
import { nodeDialer } from '@johnhenry/browsermesh-egress/node'

// the provider: a pod with sockets
const service = attachService(node, undefined, createMeshProtocolService())
const egress = createMeshEgress({
  service,
  registry: node.registry,                                  // the grants are the registry's
  ...nodeDialer({ allowPrivate: [] }),                      // { dial, dialUdp, resolve, exchange } on wsh's address guard
  sets: { 'package-hosts': ['registry.npmjs.org:443', '*.alpinelinux.org:80,443'] },
  unattended: true,                                         // or an `indicator`: start() needs one of the two
  onAudit: (record) => console.log(record),
})
egress.start()                                              // off until this
node.registry.grantCapabilities(consumerPodId, [
  'protocol:egress:open',                                   // may open the channel at all
  'egress:tcp:registry.npmjs.org:443:connect',              // one host, one port
  'egress:set:package-hosts:connect',                       // anything the operator's set lists
  'egress:dns:registry.npmjs.org:resolve',                  // a lookup is its own grant
  'egress:http:registry.npmjs.org:443:fetch',               // the fetch form: the provider makes the request and sees it
  'egress:udp:time.example.org:123:send',                   // UDP datagrams to one host and port
])

// the consumer: any pod, a browser tab included
import { connectEgress } from '@johnhenry/browsermesh-egress'
const link = await connectEgress(consumerService, providerPodId)   // pinned to that pod
const socket = await link.connect('registry.npmjs.org', 443)       // a netway StreamSocket
await socket.write(bytes)                                          // resolves when the bytes have been taken
const chunk = await socket.read()                                  // null at the end of what the destination sends
await socket.end()                                                 // half-close: the destination can still send
const addresses = await link.lookup('registry.npmjs.org')          // ['104.16.0.35', ...]; rejects `name-not-found`
const res = await link.fetch('https://registry.npmjs.org/left-pad') // a Response, streamed; what CORS blocks. THE PROVIDER sees it
const flow = await link.udp('time.example.org', 123)               // one UDP flow
await flow.send(datagram)                                          // a Uint8Array up to flow.maxDatagramBytes
const reply = await flow.read()                                    // a datagram, or null at a clean end

// route a netway VirtualNetwork through it
net.addBackend('tcp', link.asBackend())
await net.connect('tcp://registry.npmjs.org:443')
```

### The provider: `createMeshEgress`

`createMeshEgress({ service, registry, dial, resolve, exchange?, dialUdp?, fetchMethods?, identifyConsumers?, auditUrls?,
connectByResolvedAddress?, keepAlive?, sets?, wide?, blockedPorts?, blockedUdpPorts?, limits?, allowFrom?, deny?, verifyRequest?,
indicator?, unattended?, onAudit?, onMeter?, clock?, recheckIntervalMs?, protocol? })` returns `{ start(), stop(), recheck(peer?),
stats(), connections, started }`.

| Option | Default | What it is |
| --- | --- | --- |
| `service` | required | a mesh service with the protocol channel |
| `registry` | required | `checkAccess` and `onAccessChange`: the grants are the registry's |
| `dial` | required | `({ host, port, wide, signal, timeoutMs }) => Promise<{ socket, address, class }>`: resolve once, check, connect to the address that was checked. `nodeDialer()` builds it |
| `resolve` | required | `({ name, wide, signal, timeoutMs }) => Promise<[{ address, class }]>`: the A records, checked by the same policy |
| `exchange` | none | the fetch form's HTTP client, `({ url, method, headers, body, dial, signal, ... }) => Promise<{ status, headers, body }>`; `nodeDialer().exchange` builds it. **Without one the fetch form is answered `not-offered`.** The provider then sees what it fetches |
| `dialUdp` | none | `({ host, port, wide, signal, timeoutMs }) => Promise<{ socket, address, class }>`: a datagram socket connected to the address that was checked (`nodeDialer().dialUdp`). Without one UDP is answered `not-offered` |
| `fetchMethods` | `['GET', 'HEAD']` | methods the fetch form serves: any of GET HEAD POST PUT PATCH DELETE OPTIONS (never CONNECT or TRACE) |
| `identifyConsumers` | `false` | add `x-browsermesh-consumer: <pod id>` to each fetch request; off, the destination never learns who asked |
| `auditUrls` | `'none'` | what the audit says of a fetched URL: `'none'` (the length of path and query only), `'path'` (and the path), `'full'` (and the query) |
| `connectByResolvedAddress` | `false` | take a `connect` to an address **this provider's own lookup returned** for the consumer as a connect to that name, under the name's grants: [Names and addresses](#names-and-addresses) |
| `keepAlive` | `{ intervalMs: 5000, misses: 3 }` | ping each consumer; one heard from in no way for `misses` intervals is gone, its channel closed and its connections and budgets freed. `false` stops this end pinging (a consumer's pings are still answered): [Liveness](#liveness) |
| `sets` | none | operator-named destination sets (below) |
| `wide` | off | `{ acknowledge: 'any-public-address' }`: see [Wide mode](#wide-mode) |
| `blockedPorts` | `[25, 465, 587]` | TCP and fetch ports no one reaches. With wide mode the defaults cannot be removed |
| `blockedUdpPorts` | `[53]` | UDP ports no one reaches: DNS is its own form (`lookup`, its own grant and rate). With wide mode 53 cannot be removed |
| `limits` | below | the budgets |
| `allowFrom` | any peer the registry admits | a list of pod ids, or `(podId, context) => boolean`, asked on open and for every request; only `true` serves. Narrows the registry, never widens it |
| `deny` | none | `({ peer, host, port }) => boolean`: the operator's veto, asked after the grant |
| `verifyRequest` | none | `({ peer, bytes, sig, request }) => boolean`: refuses a request whose signature it does not accept (the consumer's `signRequest` makes it). The package picks no cryptography |
| `indicator` | none | `{ connected(who, { stop }), disconnected(who) }`: the person at this pod sees each connection and can stop it |
| `unattended` | `false` | nobody is in front of this pod. `start()` refuses unless this is `true` or an `indicator` is given |
| `onAudit` | none | one record per open, refusal, close, lookup, and per fetch hop (below). A sink that throws never breaks a connection |
| `onMeter` | none | one record per connection, flow, fetch or lookup, and a delta every `meterIntervalMs` for a long one (below) |
| `clock` | `{ now: Date.now }` | the rate limiters' and byte budgets' clock (a test advances one) |
| `recheckIntervalMs` | `30000` | how often live connections are checked against the registry again, so an expiry is noticed |
| `protocol` | `'egress'` | the protocol name |

`start()` begins serving (and throws without an `indicator` or `unattended: true`). `stop()` ends every connection with
`shutdown` and stops serving; a stopped provider cannot be started again. `recheck(peer?)` asks the registry again about
the live connections (of one peer, or all) and ends the ones whose grant is gone, `revoked`; it runs on every
registry access change and on the interval. `stats()` is `{ channels, requests, opened, refused, closed, lookups, fetches, bytesUp,
bytesDown, pings, pongs, gone, open, reasons, ends, udp: { flows, datagramsUp, datagramsDown, dropped: { rate, credit, size, outbox } },
peers: { [podId]: { connections, open, bytesUp, bytesDown, refused, lookups } } }`,
keyed by the channel's verified peer and never by a field of a message.

### The consumer: `connectEgress`

`connectEgress(service, providerPodId, { signal?, limits?, signRequest?, protocol?, keepAlive?, mapAddresses? })` opens
protocol `egress` to that pod and returns a link: `{ peer, closed, closeReason, whenClosed, onClose(cb), connect(host, port,
{ signal }), lookup(name, { signal }), fetch(input, init), udp(host, port, { signal }), namesFor(address), asBackend(), stats(),
close() }`. (A page that does not already have a mesh node uses `createEgressNode` from `./browser`, above.)

- The link is **pinned**: a channel bound to any pod other than the one named is closed and refused
  (`provider-pin-mismatch`). **Opening fails with a code that says why** (a page can tell the person what to do): the provider
  has not granted the protocol (`provider-not-authorized`), does not serve it (`provider-no-egress`), speaks no common version
  (`provider-version`), refused the link itself (`provider-refused`: its channel service takes no more peers, or none),
  did not answer in time (`provider-timeout`), or this pod has no link to it (`provider-not-found`: connect to the pod first;
  `createEgressNode().connect` does, and says `signalling-unreachable` when the signalling server is the problem).
  `provider-unreachable` stays the catch-all for what none of these names. Routed delivery is not part of this version.
- **The link says when and why it ended.** `closed` stays a boolean (it always was one). `closeReason` is `undefined` while the
  link is up and then one of the reasons below; `whenClosed` resolves `{ reason }`; `onClose(cb)` calls `cb({ reason })` once
  and returns a function that removes it. Everything that was open ends promptly with a typed error: a connect, a lookup or a
  fetch that was waiting, an open socket's `read()`, a flow's.

<!-- close-reasons-table:begin -->
| Reason | Meaning |
| --- | --- |
| `local-close` | This side closed the link (`link.close()`). |
| `provider-gone` | Nothing was heard from the provider for the keep-alive window: it was killed or cannot be reached. |
| `provider-closed` | The provider or the transport closed the channel, and said nothing this package knows the meaning of (an older provider says nothing). |
| `provider-stopped` | The provider stopped, or is not serving. |
| `revoked` | The provider closed the channel because this pod's access to the protocol was revoked. |
| `provider-refused` | The provider closed the channel because it does not serve this pod (its `allowFrom`). |
| `protocol-violation` | One end broke the stream rules, or sent too many malformed requests, and the channel was cut. |
<!-- close-reasons-table:end -->

What was open fails with `provider-gone` after a keep-alive loss, `link-closed` after `close()`, and `provider-closed` (or
`connection-ended` with the provider's `reason`) for every other end. The reasons other than `local-close`, `provider-gone`
and `protocol-violation` come from what the provider said as it closed the channel, so they need a provider running
`@johnhenry/browsermesh-apps` `>=0.25.0`; from an older one the reason is `provider-closed`.

Also on the consumer:
- `connect(host, port)` resolves with a netway `StreamSocket`: `write()` resolves when the bytes have been taken, `read()`
  resolves a chunk or `null` at the end of what the destination sends, `end()` is the half-close (the destination can
  still send), `close()` and `destroy(err)` end both directions. **Pause and resume are `read()`**: a socket nobody reads
  stops the destination, and everything held anywhere stays within the windows below. `host` is a lowercase DNS name or
  four plain decimal numbers (`checkHost`; anything else is `bad-destination`), and **never a mesh pod id** (that is
  `chaining-refused`).
- `lookup(name)` resolves the IPv4 addresses of a name (at most 16). It rejects `name-not-found` (`error.posix` is
  `ENOTFOUND`) for a name that does not exist, and `lookup-failed` for a resolver failure: the two are never the same
  error. A provider's answer is not an identity; use TLS.
- `fetch(input, init)` is `fetch` through the provider: a `Response` back, `init.signal` honoured, the body a stream that
  only moves as it is read. **The provider makes the request and sees all of it** ([The fetch form](#the-fetch-form)).
  `response.url` and `response.redirected` are the provider's word.
- `udp(host, port)` resolves with a flow `{ maxDatagramBytes, closed, send(datagram), read(), close() }`, async iterable:
  `send` rejects `datagram-too-large` above `maxDatagramBytes` and resolves when the provider has the datagram; `read()`
  resolves a datagram, or `null` once the flow ended cleanly, and rejects with an `EgressError` (`connection-ended` with a
  `reason`, ...) when it ended otherwise ([UDP](#udp)).
- `asBackend()` is a netway `Backend` (`connect`, `resolve` for `A`; `listen` and datagrams are not offered):
  `net.addBackend('tcp', link.asBackend())`. A refused connection (`connect-failed` with `detail: 'refused'`) is netway's
  `ConnectionRefusedError`; every other failure stays an `EgressError`. Closing the backend leaves the link open.
- `limits`: `{ openTimeoutMs: 10000, requestTimeoutMs: 30000, maxConnections: 32, streamWindowBytes: 262144,
  socketWindowBytes: 262144, maxViolations: 8 }`. `signRequest(bytes, { peer })` signs each connect and lookup for the
  provider's `verifyRequest`.
- `keepAlive: { intervalMs: 5000, misses: 3 }` (or `false`): the link pings the provider and ends `provider-gone` when nothing
  is heard for `misses` intervals ([Liveness](#liveness)). `mapAddresses: true` (or `{ ttlMs: 600000, maxEntries: 256 }`;
  off by default): when the provider refuses an **address** (`no-grant`) that this link's own lookup answered for a name, `connect`
  asks for the name instead; `link.namesFor(address)` is what it remembers ([Names and addresses](#names-and-addresses)).
- Every failure is an `EgressError` with a stable `code` (below), and `budget`, `addressClass`, `detail` or `reason` where
  the code defines one, and `posix` (`ENOTFOUND`, `ECONNREFUSED`, `ETIMEDOUT`, ...) where there is a nearest name. Types
  are in `src/index.d.ts` and `src/node.d.ts`.

### The Node dialer: `nodeDialer`

`import { nodeDialer } from '@johnhenry/browsermesh-egress/node'` returns `{ dial, dialUdp, resolve, exchange }`, the options
the provider takes, on wsh's address guard (`@johnhenry/wsh/address-guard`). **This package classifies no address**: every
decision goes through `resolveChecked`, `dialChecked` and `dialUdpChecked`. A name is resolved once, every answer is
classified, and the connection (or the connected datagram socket) is made to an address that passed, never to the name again.
`exchange` is the fetch form's HTTP client, over that same checked `dial`; it is the one file of the package that terminates TLS.

| Option | Default | What it is |
| --- | --- | --- |
| `allowPrivate` | `[]` | CIDR blocks or addresses of private space a destination **a grant names** may resolve to. Nothing else makes private space reachable. `true` is not accepted: name the space |
| `deny` | `[]` | CIDR blocks or addresses always refused, public ones included; wins over `allowPrivate` |
| `denyOwnAddresses` | `true` | also refuse the public addresses of this machine's own interfaces |
| `refuseMixed` | `true` | see below |
| `lookup` | the system's | the resolver; a test replaces it |
| `ca` | Node's roots | certificate authorities the fetch form trusts for `https:` (a private PKI) |

**A name whose answers mix a permitted and a refused address is refused whole (`refuseMixed: true`).** wsh's own default is
to drop the refused answers and connect to the rest. This package chooses the stricter one: a name that answers with both a
public and a private address is not one an operator can vouch for, and the refusal names the class of the refused address,
so the mix is visible instead of silently routed around. Pass `refuseMixed: false` to take wsh's default. (A provider that
passes its own `dial` and `resolve` makes its own choice.)

## Grants, and what a destination is

A grant is a registry scope. The registry compares scopes segment by segment and a `*` is a whole segment, so a host is
one segment and a block or a suffix cannot be written in a grant: those live in the operator's sets.

<!-- scopes-table:begin -->
| Scope | Meaning |
| --- | --- |
| `protocol:egress:open` | may open the protocol channel at all (default deny, re-asked for every message of the channel) |
| `egress:tcp:<host>:<port>:connect` | open TCP to exactly that host and port |
| `egress:tcp:<host>:*:connect` | any port of exactly that host; the blocked ports still apply |
| `egress:dns:<name>:resolve` | look up exactly that name; connecting by name does not carry it |
| `egress:set:<name>:connect` | connect to anything the operator's set of that name lists |
| `egress:http:<host>:<port>:fetch` | the fetch form to exactly that host and port: **the provider makes the request and sees it** |
| `egress:http:<host>:*:fetch` | the fetch form to any port of exactly that host; the blocked ports still apply |
| `egress:set:<name>:fetch` | the fetch form to anything the operator's set lists (a set's `connect` grant is not this one) |
| `egress:udp:<host>:<port>:send` | UDP datagrams to exactly that host and port, and what that address answers |
| `egress:udp:<host>:*:send` | UDP to any port of exactly that host; the blocked UDP ports still apply |
| `egress:set:<name>:send` | UDP to anything the operator's set lists |
<!-- scopes-table:end -->

- **One grant per form and per destination.** A TCP grant is not a fetch grant, a fetch grant is not a UDP grant, and none is a
  lookup grant: each says a different thing about what the provider sees. A fetch grant names an origin (host and port); the
  default port of the scheme is used when the URL has none.
- `<host>` and `<name>` are lowercase DNS names or four plain decimal numbers (no `:`, no `*`). A grant for a name does not
  cover that name's address, and the reverse (a guest that connects by the address its lookup returned needs
  [Names and addresses](#names-and-addresses)). Every other spelling of an address (`127.1`, `0x7f.1`, `2130706433`, a
  trailing dot) and every IPv6 literal is `bad-destination` before any rule is asked, so no rule sees two spellings of
  one address. A port is 1 to 65535.
- Each can carry `expiresAt` (`grantCapabilities(peer, scopes, { expiresAt })`). The provider notices an expiry on its
  interval (or `recheck()`) and ends the live connections `revoked`.
- No default template, join gate or helper in this repository creates an `egress:*` grant.
- **A request with no grant is answered `no-grant`, the same whether or not the destination exists or is reachable, before
  any lookup** (a consumer learns nothing about what the provider can reach). A lookup is its own grant, with its own rate:
  connecting by name never carries one.

**Sets.** `sets: { name: [entry, ...] }`, written by the operator, evaluated only on the provider. An entry is `host:ports`:

| Entry | Matches |
| --- | --- |
| `registry.npmjs.org:443` | that name |
| `*.alpinelinux.org:80,443` | any subdomain at any depth, never the apex; the suffix needs at least two labels |
| `203.0.113.7:443` | that IPv4 literal |
| `203.0.113.0/24:443` | an IPv4 block, for destinations given as IP literals (a name is never looked up to see whether it falls in a block) |

Ports are `*`, or numbers and ranges (`80,443,8000-8100`). A bare `*` host, `*:443`, `*.com` and IPv6 are refused at
construction: wide access is a mode, never a set. A set name is a scope segment (lowercase letters, digits, `.`, `_`, `-`).

## Names and addresses

A grant is for a name (`egress:tcp:registry.example:443:connect`), and a guest operating system connects by the **address** its
own lookup returned. The provider's `connect` for `93.184.216.34` is a request for an address, which no grant for the name
covers (`no-grant`): the reverse of the rule above, and the right default. A container engine in a page, whose guest looks a
name up through `link.lookup` and then connects to what it was given, needs one of two things.

**At the provider: `connectByResolvedAddress: true` (off by default).** For each consumer link the provider remembers which
addresses *its own lookup* returned, under the consumer's `dns` grant, for which names: at most `limits.maxRememberedAddresses`
(256) pairs, each for `limits.addressMemoryMs` (ten minutes) from the lookup, the oldest forgotten first. A `connect` to an
address that is in that memory, from that consumer, on a link it looked the name up on, is taken as a connect to the name:

- **the name's own grants decide**, the consumer's TCP grant for that name and port (exact, any port, or an operator's set), and
  the consumer must still hold the name's `dns` grant. An address returned for a name the consumer holds no TCP grant for, or
  a port the grant does not name, gives nothing: `no-grant`, as without the option;
- **the address is what is dialled**: the provider hands its `dial` the address it resolved, so there is no second lookup, nothing
  the consumer supplies decides where the connection goes, and the address guard checks it as it checks every other address
  (an address that is private, loopback, link-local or metadata is refused whatever the memory says);
- **the operator's `deny` is asked about the address and about the name**, the blocked ports, the budgets and the audit apply as
  to any connect (`egress-open` carries `via: 'resolved-name'` and the `name`), and revoking either grant ends the path at once and
  a live connection `revoked`;
- **nothing is taken from the consumer**: the request has no field that names a mapping (extra fields are ignored), and the memory
  is per link, never shared;
- what a holder of the two grants gains is a connection to an address the name resolved to a moment ago: the same machines it
  could already connect to by name. A shared host that serves other names is reached as the granted name's address, as it is
  by name. No wildcard grant is involved (those are wide mode's, and decide on their own). It applies to the TCP connect form;
  the fetch form and UDP take their destination from a URL or a name the consumer writes.

**At the consumer: `mapAddresses: true` (off by default)**, which works against any provider, 0.1.1 and 0.2.0 included. The link
remembers what its own lookups answered. When the provider refuses an address with `no-grant` and the address was answered for
a name, the link asks for the name instead (newest first, at most three names), and from then on goes straight to names for this
provider. Only `no-grant` leads to a name, and only a name this link looked up itself. It costs a second lookup at the
provider, which may pick another address of the same name; where that matters, the provider's option is the exact one.
`createAddressMemory({ ttlMs, maxEntries })` is exported for a consumer that routes by itself.

```js
// provider: the operator
createMeshEgress({ ..., connectByResolvedAddress: true })
node.registry.grantCapabilities(consumerPodId, ['protocol:egress:open', 'egress:dns:registry.example:resolve', 'egress:tcp:registry.example:443:connect'])

// consumer: a guest looks up, then connects to the address it was given
const [address] = await link.lookup('registry.example')
const socket = await link.connect(address, 443)       // taken as registry.example:443
```

## Wide mode

By default a peer can reach only what a grant names. A **wildcard grant** (a literal `*` where a host goes:
`egress:tcp:*:443:connect`, `egress:tcp:*:*:connect`, `egress:http:*:*:fetch`, `egress:udp:*:*:send`, `egress:dns:*:resolve`,
`egress:*`, `egress:tcp:*`, `*`) would make
the provider an open proxy for its holder, so:

- **A wildcard grant is refused `wide-not-acknowledged`** unless the operator acknowledged it. The provider asks the
  registry about the literal-`*` forms for each request (the registry matches a literal `*` only against a wildcard
  grant, as the relaying pod does for `wsh-relay:*`), and refuses a holder of one even if an exact grant would also cover
  the request.
- **Acknowledging it is writing `wide: { acknowledge: 'any-public-address' }`** in `createMeshEgress`. Nothing else
  turns it on: not a grant, not a default, not a peer. `start()` still needs an `indicator` or `unattended: true`, every
  budget still applies (a limit cannot be unlimited), and the provider refuses to be built with wide mode and a
  `blockedPorts` that drops 25, 465 or 587.
- **What it means for you:** every holder of such a grant can reach every public address on every port but the blocked
  ones, from your address, for as long as the grant lives. Grant it to as few keys as possible, with `expiresAt`.
- **It reaches public destinations only.** A destination admitted by a wildcard grant is dialled with `wide: true`: private,
  loopback, link-local, unique-local, carrier-NAT, metadata, multicast and reserved space stay refused, **whatever
  `allowPrivate` allows for destinations a grant names**, and the provider checks the class the dial reports and refuses a
  non-public one even from a dial that ignored the flag. Only the operator's own `allowPrivate`, for a destination an
  exact grant or a set names, admits private space. A peer's grant never does.

## The fetch form

`link.fetch(input, init)` takes what `fetch` takes and returns a `Response`. It exists because a browser page is bound by CORS
and cannot run TLS on a raw stream: registries, APIs and feeds that do not send CORS headers can only be reached by a peer that
makes the request for it.

**The provider is the HTTP client, so it sees everything.** For `https:` the provider does the TLS: it reads the URL, the
headers (an `Authorization` the consumer sent, included), the request body and the response, and it could alter the response. The
consumer cannot tell. That is why the fetch form has its own scope (`egress:http:<host>:<port>:fetch`, a grant per destination
origin, never covered by a TCP grant), why the provider offers it only when given an `exchange`, and why this README says so
plainly: a fetch grant is trust in the provider with that request and its answer, not only in its network. Where the page can
run TLS itself over `connect()`, use that: the provider then carries bytes it cannot read.

What the provider does, per request, in this order:

1. **The request is checked.** `http:` or `https:` only, no credentials in the URL, a lowercase DNS name or a dotted IPv4
   address (no IPv6 literal, no pod id), at most 8192 characters; the method must be one the operator lists (`fetchMethods`,
   default GET and HEAD; CONNECT and TRACE never). `no-grant` is said before anything about the URL or the network is looked at.
2. **Headers are an allow-list in both directions.** On the way out only `accept`, `accept-language`, `authorization`,
   `cache-control`, `content-length`, `content-type`, the conditional headers, `pragma` and `range` are sent on, each once.
   `Host` is built from the parsed URL, never taken from the consumer. The provider adds `user-agent: browsermesh-egress`,
   `accept-encoding: identity` and `connection: close`; it adds no `Authorization`, no cookie and no `Origin` or `Referer`, and
   the consumer's pod id only if the operator set `identifyConsumers`. On the way back only a fixed list passes, each header at
   most 8192 characters, at most 100 in all and the whole block within `maxHeaderBytes`: what describes the body and its
   caching (`content-type`, `content-length`, `content-range`, `accept-ranges`, `content-encoding`, `content-language`,
   `content-disposition`, `etag`, `last-modified`, `cache-control`, `expires`, `age`, `date`, `vary`), what a client needs to be
   told next (`location`, `retry-after`, `link`, `www-authenticate`), and what registries and ordinary APIs say about
   themselves (`docker-distribution-api-version`, `docker-content-digest`, the `ratelimit-*` and `x-ratelimit-*` limit,
   remaining and reset): never `Set-Cookie`, a hop-by-hop or a proxy header, and nothing that is not on the list.
   **A header that carries a URL the consumer will act on (the realm in `www-authenticate`, `link`, `location`) is the
   provider's word, as `response.url` is.** A provider (or a destination the provider fetched from) can point the consumer
   anywhere; the consumer's request to that URL is its own `fetch` and still needs its own grant (`no-grant` otherwise), so the
   header gives a hostile provider no reach it did not already have. Check the host of a realm before sending a credential to it.
3. **The destination is checked, then dialled at the address that was checked.** The name is resolved once by wsh's address
   guard, every answer is classified, and the connection (and, for `https:`, the TLS handshake, whose SNI and certificate
   check use the name) goes to an address that passed: a second DNS answer cannot change where the connection goes.
   Private, loopback, link-local and metadata addresses are refused with their class.
4. **Redirects are followed by the provider, hop by hop, and each hop is a new request:** the target must be a destination the
   consumer also holds a fetch grant for (`redirect-refused` otherwise, before any lookup), its address is checked again, the
   blocked ports and the operator's `deny` apply, `https:` never falls back to `http:`, `Authorization` is dropped when the
   origin changes, 303 (and 301 or 302 after a POST) become a GET without the body, and a 307 or 308 that would need the body
   again is refused. At most `maxRedirects` (5). `redirect: 'manual'` returns the 3xx with its `Location`; `'error'` rejects.
5. **The response is streamed with backpressure.** The next chunk is read from the destination only when the consumer has read
   the last, so a page that stops reading stops the destination. The body is never decompressed (the destination's bytes and
   `content-encoding` reach the consumer as sent). It is bounded in bytes (`maxFetchResponseBytes`, 8 MiB), in time
   (`maxFetchDurationMs`, 30 s, and `headersTimeoutMs` for the head, and the idle budget) and the request body in
   `maxFetchRequestBytes` (1 MiB). A bigger blob is a job for `connect()`, or for an operator who raises the limit.
6. **It is audited and metered like the other forms.** One `egress-hop` per hop, an `egress-open` and an `egress-close`. The audit
   has the method, the host, the port, the **length** of the path and query, the status, the redirects and the checked address;
   never a header or a body, and the path and query only if the operator opted in with `auditUrls: 'path'` or `'full'`. The
   meter carries bytes and no destination.

What the consumer can and cannot trust from a provider it picked: the `Response` is the provider's word. `status`, `headers`,
`body` and `response.url` can be invented by a dishonest provider, and for `https:` the consumer cannot check the certificate
itself. The consumer pins the provider's pod id and the response is bounded and filtered (a status outside 200 to 599, headers
that are not pairs, a header outside the allow-list or with a control character, a URL that is not `http(s)`: `bad-answer` or
dropped), but nothing authenticates the content. Treat the body as untrusted bytes, as for any fetch, and check what you can
check yourself (a registry client checks the digest of what it downloaded).

### Pulling from a public registry through the fetch form

A registry pull is several fetches to several hosts, and the provider follows redirects only to hosts the consumer holds a fetch
grant for, so a pull needs the redirect hosts written down. The usual shape (the hosts are what the registries named below
answered with at the time of writing, and they change: not checked against the live registries here, so read your own provider's
audit, `egress-hop` and `egress-refused` lines, on a first pull and amend the sets):

1. `GET https://registry.example/v2/` answers `401` with `www-authenticate: Bearer realm="https://auth.example/token",service="..."`.
   The realm is the **token service**, another host: fetch it with the scope the challenge named, then retry with
   `authorization: Bearer <token>`. (`www-authenticate` reaches the consumer; before it was dropped.)
2. The manifest comes from the registry; `docker-content-digest` is the digest to check what you download against.
3. A blob answers `307` with a `location` on the registry's **blob storage or CDN host**: a third host. The provider follows it
   only if the consumer holds a fetch grant for it; `Authorization` is dropped on the way (the origin changed), which is what a
   storage host wants.

So the operator names each registry's hosts as a set, and grants the sets to the consumer:

```js
createMeshEgress({
  ...nodeDialer(),
  sets: {
    'docker-hub': ['registry-1.docker.io:443', 'auth.docker.io:443', 'production.cloudflare.docker.com:443'],
    'ghcr': ['ghcr.io:443', 'pkg-containers.githubusercontent.com:443'],
    'quay': ['quay.io:443', 'cdn01.quay.io:443', 'cdn02.quay.io:443', 'cdn03.quay.io:443'],
  },
  // layers are tens to hundreds of MiB: the fetch's own bound and the connection's must both be raised, and the time
  limits: { maxFetchResponseBytes: 512 * 1024 * 1024, maxBytesPerConnection: 512 * 1024 * 1024, maxFetchDurationMs: 10 * 60_000 },
  unattended: true,
})
node.registry.grantCapabilities(consumerPodId, ['protocol:egress:open', 'egress:set:docker-hub:fetch', 'egress:set:ghcr:fetch'])
```

Three limits bound one fetch, and a layer passes only when all three allow it: `maxFetchResponseBytes` (8 MiB by default) for
the body, `maxBytesPerConnection` (64 MiB) for the connection both ways, and `maxFetchDurationMs` (30 s) for its whole life;
the consumer's own `maxBytesPerConsumer` (1 GiB a day) still counts every byte. A pull that needs more than you want the provider
to buffer-and-forward for one request should not go through the fetch form at all:

**For large bodies, `connect` and the consumer's own TLS.** Grant the TCP form for the storage host
(`egress:tcp:production.cloudflare.docker.com:443:connect` and its `egress:dns:...:resolve`) and run TLS in the page over the
`StreamSocket`: the provider then carries bytes it cannot read, and its limit is `maxBytesPerConnection`, not the fetch's. The
small requests (the challenge, the token, the manifest) can still go through `fetch`. Which of the two to use is the question
of who may read the layer: through `fetch` the provider reads every byte; through `connect` it reads none. (A page that does the
TLS itself also checks the certificate itself, which the fetch form cannot offer it.)

## UDP

`link.udp(host, port)` opens one flow to one destination: `send(datagram)`, `read()`, `close()`. The grant is
`egress:udp:<host>:<port>:send`, and DNS stays its own form: UDP port 53 is refused for every grant, wide mode included.

- **Over the mesh a flow is a pair of reliable streams** (datagrams as frames: a 2-byte length and the payload), so datagrams
  reach the provider in order and with backpressure. **Beyond the provider the network keeps UDP's semantics**: a datagram can
  be lost, reordered or duplicated there. The provider **drops** a datagram it will not pass on, silently, as a network would;
  `stats().udp.dropped` counts each reason and the audit says how many a flow lost.
- **The socket is connected to the checked address** (wsh's `dialUdpChecked`): the kernel drops every datagram that does not
  come from that address and port, so the destination cannot be made a relay for others, and a name that answers differently
  later does not matter.
- **Budgets, per flow and per consumer.** A flow carries at most `maxDatagramBytes` per datagram (1472: what fits an Ethernet
  frame, at most 65507), `maxUdpDatagramsPerFlow` datagrams and `maxUdpBytesPerFlow` bytes in both directions, and idles out
  after `udpIdleMs`. A consumer has `maxUdpFlowsPerConsumer` flows at once, a rate of `udpDatagramRate` datagrams in both
  directions (over it, datagrams are dropped; they still count against the flow's datagram budget, so a flood ends the
  flow), and its bytes count against the same per-consumer budget as the other forms.
- **No amplification: replies are bounded by what the consumer sent.** A reply from the destination is passed on only if the
  consumer's own sends earned the credit for it. Each datagram sent earns `max(udpReplyFloorBytes, size * udpReplyRatio)`
  bytes of credit (at least 4096, or 8 times the datagram), held up to `udpReplyCreditMaxBytes`, and a reply larger than the
  credit left is dropped (so a flow starts with none, and a destination that sends unprompted is not heard). A destination
  cannot turn one small datagram into more than a few kilobytes of replies, and cannot bank a burst by staying silent. The
  consumer's stream also holds at most `udpOutboxBytes` of replies it is not reading; the rest are dropped.
- **What a consumer can trust:** a datagram read is the provider's word. A dishonest provider can invent a reply; a datagram is
  the destination's only if the protocol inside authenticates it (DTLS, QUIC, a signature). A frame longer than the bound the
  provider announced fails the flow `bad-answer`.

## The command line

`browsermesh-egress` runs a provider on a Node host: it joins a signaling server under a persistent identity, prints its pod
id (the id a consumer connects to), applies the grants of a JSON file, and prints one line per audit event.

```
npx browsermesh-egress --config grants.json --signaling wss://signal.example --identity ./egress-identity.json
npx browsermesh-egress --config grants.json --dry-run        # print what would be allowed, start nothing, touch no key
```

```json
{
  "grants": [
    { "peer": "<the consumer's pod id>", "scopes": ["egress:tcp:registry.npmjs.org:443:connect", "egress:http:registry.npmjs.org:443:fetch", "egress:dns:registry.npmjs.org:resolve"], "expiresAt": "2026-12-31T00:00:00Z" }
  ],
  "sets": { "package-hosts": ["registry.npmjs.org:443", "*.alpinelinux.org:80,443"] },
  "limits": { "maxFetchResponseBytes": 33554432 }
}
```

- `--allow PODID=SCOPE[,SCOPE]` and `--set NAME=ENTRY[,ENTRY]` are the same as the file's `grants` and `sets`; `--allow-private`
  and `--deny` take CIDR blocks; `--fetch-methods`, `--audit-urls` and `--identify-consumers` are the library's options;
  `--json` prints each audit record as one JSON line. Run `--help` for all of them.
- **Only the exact scopes of this package are accepted** (a broad `egress:*` or `*` is not written in a CLI grant, and a typo is
  refused, not ignored), a pod id must be a pod id, an `expiresAt` must be in the future, and a set a grant names must exist.
- **`--dry-run` says in sentences what each peer could do**, including that a fetch grant lets this machine read the request,
  and validates the limits and sets exactly as the running provider would. It starts no node and reads or writes no identity.
- **Wide mode takes two flags every time: `--wide --acknowledge-wide any-public-address`.** A wildcard grant (a `*` in the
  host place) without both is refused at start (exit 2), and the config file cannot turn wide mode on. Private, loopback,
  link-local and metadata space stay refused in wide mode.
- The audit lines carry what the audit table below says and nothing of the payloads; paths and queries only with
  `--audit-urls`.

## Compatibility with 0.1.1

Protocol `egress` is still version 1 and nothing in 0.1.1's messages changed: the fetch form and UDP are two **new request
methods** (`fetch`, `udp`) on the same protocol, with new scopes and new refusal codes only they can produce. A consumer that does
not ask for them is never sent anything new.

- **A 0.1.1 consumer against this provider** works unchanged: the same requests get the same answers, whether the new forms are
  on or off (a test pins 0.1.1's messages as literals).
- **This consumer against a 0.1.1 provider**: `connect` and `lookup` work; `fetch` and `udp` are answered
  method-not-found by the older provider, which the consumer reports as `provider-no-form`. Nothing is left open, the older
  provider's handlers are never reached, and the link keeps working.
- **This consumer against this provider with a form off** (no `exchange`, no `dialUdp`): `not-offered`, said only after the grant
  check, so a consumer learns nothing about the provider's configuration without a grant.

## Compatibility with 0.2.0

Protocol `egress` is still version 1 and nothing 0.2.0 sent or understood changed. What was added is additive or negotiated,
and each end can run either version:

| Change | A 0.2.0 or 0.1.1 peer |
| --- | --- |
| More response headers pass the fetch form (`www-authenticate`, `link`, `docker-*`, `ratelimit-*`) | **Provider:** it sends the new headers only from a new provider. **Consumer:** a 0.2.0 consumer drops what its own list lacks and reads the rest of the answer as before; a new consumer simply sees none of them from an old provider. |
| `connectByResolvedAddress` (provider) | No wire change: the same `connect { host: <address> }` is refused `no-grant` by a 0.2.0 or 0.1.1 provider, as before. A consumer with `mapAddresses` then asks for the name. |
| `mapAddresses` (consumer) | No wire change: it sends `connect` for a name, which every provider serves. |
| The keep-alive: a `ping` request on the channel, answered `{ ok: true }` | An older peer has no `ping` and answers `method-not-found`, which is an answer: the pinging end counts it as proof the peer is there and goes on, and never declares an older peer gone for lacking the method. An older peer pings nothing, so a new end simply waits on its own pings. A peer that answers nothing at all is the one declared gone. A 0.2.0 consumer on a new provider is pinged, answers `method-not-found`, and is served as before; a dead one is noticed all the same. |
| Why the other end closed (`closeReason`), from a field `reason` on the protocol host's close notification | An older provider sends no reason and the link's `closeReason` is `provider-closed`; an older peer that receives the field ignores it. |
| New link codes (`provider-not-found`, `provider-refused`, `signalling-unreachable`, `provider-gone`) | Client-side only: nothing new on the wire. A 0.2.0 consumer reports what used to be the catch-all `provider-unreachable` for the two open failures that now have their own codes. |
| `./browser` and `createEgressNode` | Client-side only. It needs `@johnhenry/browsermesh-apps` `>=0.25.0` for the lean node it is built on. |

## Liveness

Nothing in a data channel says when the other end was killed outright: with a real WebRTC link on both ends the transport's own
timers took about 237 s to (in a consumer's measurement). So each end of an egress channel runs a keep-alive on the protocol
channel: a `ping` request every `intervalMs` (5 s), answered `{ ok: true }` at once, and the other end is **gone** when nothing at
all has been heard from it, no answer to a ping, no ping of its own and no message of the protocol, for `misses` intervals
(3, so about 15 s). Anything heard counts: a link busy with a large download is not declared gone because a ping waited behind it.

- **The consumer** ends the link `provider-gone`: what was waiting (`connect`, `lookup`, `fetch`) fails with `provider-gone`, so does
  every open socket's `read()` and every flow, and the mesh link under it is closed too, so a provider that comes back is
  opened fresh. `link.whenClosed` and `link.onClose` say so.
- **The provider** closes the dead consumer's channel and its mesh link: its connections end `consumer-left`, its slots and
  budgets are free (`egress-consumer-gone` in the audit, `gone` in `stats()`).
- Measured with real WebRTC (node-datachannel on both ends, the other end a child process killed with SIGKILL): the survivor
  noticed after 15.0 s in both directions with the defaults.
- `keepAlive: false` turns an end's pinging off (it still answers); `{ intervalMs, misses }` changes it. A fast interval costs one
  small request per interval per link. An end that is not pinged by the other still notices a vanished peer only as fast as the
  transport does, so set both ends.

## Budgets

<!-- defaults-table:begin -->
| Limit (`limits.`) | Default | What it bounds | Refusal or end |
| --- | --- | --- | --- |
| `maxConnectionsPerConsumer` | 16 | open connections of one consumer | `budget-exceeded` (`connections-per-consumer`) |
| `maxConnections` | 64 | open connections of all consumers | `budget-exceeded` (`connections-global`) |
| `connectRate` | 120 a minute | connection attempts of one consumer (refused ones count) | `budget-exceeded` (`connect-rate`) |
| `globalConnectRate` | 600 a minute | connection attempts of all consumers | `budget-exceeded` (`connect-rate-global`) |
| `dnsRate` | 30 a minute | lookups of one consumer | `budget-exceeded` (`dns-rate`) |
| `maxBytesPerConnection` | 64 MiB | one connection, both directions together | the connection ends `byte-budget` |
| `maxBytesPerConsumer` | 1 GiB per 24 hours | one consumer, both directions, a fixed window from its first byte | `budget-exceeded` (`bytes-per-consumer`) for a new connection; a live one ends `consumer-budget` |
| `connectTimeoutMs` | 15000 | resolve, check and connect | `connect-failed` (`timeout`) |
| `idleMs` | 300000 | nothing moving in either direction | the connection ends `idle` |
| `maxDurationMs` | 3600000 | the life of a connection | the connection ends `time-budget` |
| `upWaitMs` | 10000 | the consumer opening its sending stream after the answer | the connection ends `up-timeout` |
| `maxFetchRequestBytes` | 1 MiB | the request body of one fetch | `budget-exceeded` (`fetch-request-bytes`) |
| `maxFetchResponseBytes` | 8 MiB | the response body of one fetch | the body fails `byte-budget` |
| `maxFetchDurationMs` | 30000 | the whole life of a fetch, request to last body byte | the body fails `time-budget` |
| `maxRedirects` | 5 | redirects followed for one fetch | `too-many-redirects` |
| `maxHeaderBytes` | 16384 | the header block of a fetch request or a response | `bad-request` or `bad-response` |
| `headersTimeoutMs` | 30000 | the request to the final response head, every hop together | `connect-failed` (`timeout`) |
| `maxDatagramBytes` | 1472 | the payload of one datagram | dropped (a reply); the consumer's `send` rejects `datagram-too-large` |
| `maxUdpFlowsPerConsumer` | 8 | open UDP flows of one consumer | `budget-exceeded` (`udp-flows-per-consumer`) |
| `udpIdleMs` | 30000 | nothing sent or received on a flow | the flow ends `idle` |
| `udpDatagramRate` | 500 a second | datagrams of one consumer, both directions | the rest are dropped |
| `udpOutboxBytes` | 65536 | replies held for a consumer that is not reading | the rest are dropped |
| `maxUdpDatagramsPerFlow` | 50000 | datagrams of one flow, both directions, dropped ones included | the flow ends `datagram-budget` |
| `maxUdpBytesPerFlow` | 16 MiB | payload bytes of one flow, both directions | the flow ends `byte-budget` |
| `udpReplyRatio` | 8 | reply credit earned per byte the consumer sends | a reply over the credit is dropped |
| `udpReplyFloorBytes` | 4096 | reply credit earned per datagram sent, at least | a reply over the credit is dropped |
| `udpReplyCreditMaxBytes` | 262144 | reply credit held at once | a reply over the credit is dropped |
| `addressMemoryMs` | 600000 | how long an address this provider's lookup returned is taken for its name (`connectByResolvedAddress`) | the address is `no-grant` again |
| `maxRememberedAddresses` | 256 | (address, name) pairs remembered per consumer link (`connectByResolvedAddress`) | the oldest lookup is forgotten first |
<!-- defaults-table:end -->

Also `meterIntervalMs` (60000), `maxBadRequests` (8: malformed requests and refused streams of one channel before the
channel is closed), `maxViolations` (8: stream rules one consumer may break before it is cut off), `streamWindowBytes`
(262144) and `maxTracked` (10000: consumers tracked at once, which bounds the package's own memory). Every limit is a
finite positive whole number; there is no way to say unlimited. A consumer's counters are the provider's, keyed by the
channel's verified peer, never by a field of a message.

**Backpressure, end to end.** A connection is two protocol streams (consumer to provider, `up`; provider to consumer,
`down`), each with a byte window the receiver grants and the reader returns as it consumes. The provider pauses the
destination while a chunk waits for credit, and reads the consumer's stream only as fast as the destination takes
writes. A consumer that stops reading stops the destination once its socket window and the stream window are full (256
KiB each by default: 576 KiB had moved in the real-peer run, and the tests assert a bound of 1 MiB); a destination that
stops reading stops the consumer's `write()`. Each half closes on its own: a destination that has finished sending still
accepts what the consumer sends, and the reverse.

## Refusals, in one place

Every refusal a provider makes is `{ ok: false, code, ... }` on the wire and an `EgressError` with that `code` on the
consumer. The codes are exported (`REFUSAL_CODES`, `BUDGET_NAMES`, `END_REASONS`, `LINK_CODES`, and `CLOSE_REASONS` above) and a
test pins each table to its export.

<!-- refusals-table:begin -->
| Code | Meaning |
| --- | --- |
| `no-grant` | The consumer holds no grant for this destination. Said the same whether or not the destination exists or is reachable, before any lookup. |
| `destination-refused` | The address the destination resolves to (or is) is refused by the provider's address policy; `addressClass` says which kind of address. |
| `budget-exceeded` | A budget of the provider is spent; `budget` says which. |
| `wide-not-acknowledged` | The consumer holds a wildcard grant and the provider's operator has not acknowledged wide mode. |
| `chaining-refused` | The request arrived through, or names, another egress; a provider only dials from its own network. |
| `shutting-down` | The provider is stopping and takes no new work. |
| `port-blocked` | The port is on the provider's blocked list (mail submission ports for TCP and the fetch form, port 53 for UDP, by default). |
| `bad-request` | The request is not shaped as protocol `egress` version 1 asks. |
| `bad-destination` | The host is not a lowercase DNS name or a canonical IPv4 dotted quad, or the port is not 1 to 65535. |
| `name-not-found` | The name does not exist (the resolver said so). |
| `lookup-failed` | The name could not be looked up (the resolver failed, or timed out). |
| `connect-failed` | The connection was not made; `detail` is `refused`, `unreachable`, `timeout`, `certificate` (the server's certificate is not valid for the name asked for) or `failed`. |
| `bad-url` | The URL is not an `http:` or `https:` URL this provider serves: another scheme, credentials in it, or too long. |
| `method-not-allowed` | The method is not one this provider lets a consumer use for the fetch form (GET and HEAD unless the operator lists more). |
| `redirect-refused` | The destination answered with a redirect this provider will not follow: the target is a destination the consumer holds no grant for, another scheme, a downgrade from https, or needs a request body to be sent again. |
| `too-many-redirects` | The destination redirected more times than the provider follows (`limits.maxRedirects`). |
| `bad-response` | The destination's answer is not one the provider will pass on: a malformed or oversized head, or too many headers. |
| `not-offered` | This provider does not offer this form (it was given no way to make the request). |
| `unknown` | The provider refused for a reason this version does not name, or answered with something unreadable. |
<!-- refusals-table:end -->

`destination-refused` carries `addressClass`, one of wsh's: `public` (only from a dial that was told wide mode),
`unspecified`, `loopback`, `private`, `unique-local`, `link-local`, `metadata`, `carrier-nat`, `documentation`,
`benchmarking`, `multicast`, `teredo`, `reserved`. A refused address is refused the same whether or not anything listens
there: it is denied before any dial, so the provider's own network cannot be probed through the failure code.

**Which budget** a `budget-exceeded` names:

<!-- budgets-table:begin -->
| Budget | Meaning |
| --- | --- |
| `connections-per-consumer` | Open connections of this consumer are at `limits.maxConnectionsPerConsumer`. |
| `connections-global` | Open connections of all consumers are at `limits.maxConnections`. |
| `connect-rate` | This consumer asked for more connections in the window than `limits.connectRate` allows (refused attempts count). |
| `connect-rate-global` | All consumers together asked for more connections in the window than `limits.globalConnectRate` allows. |
| `dns-rate` | This consumer asked for more lookups in the window than `limits.dnsRate` allows. |
| `bytes-per-consumer` | This consumer has moved `limits.maxBytesPerConsumer` bytes (both directions) in the window. |
| `fetch-request-bytes` | The request body of a fetch is larger than `limits.maxFetchRequestBytes`. |
| `udp-flows-per-consumer` | Open UDP flows of this consumer are at `limits.maxUdpFlowsPerConsumer`. |
<!-- budgets-table:end -->

**Why an open connection ended** (the audit's and the meter's `reason`, and `error.reason` on a socket that fails with
`connection-ended`):

<!-- ends-table:begin -->
| Reason | Meaning |
| --- | --- |
| `closed` | Both halves finished, or the origin closed after it had finished sending. |
| `revoked` | The consumer's grant for this destination was revoked or expired, or its access to the protocol was. |
| `shutdown` | The provider stopped. |
| `byte-budget` | The connection moved `limits.maxBytesPerConnection` bytes (both directions together); a UDP flow, `limits.maxUdpBytesPerFlow`; a fetch, `limits.maxFetchRequestBytes` for its request body or `limits.maxFetchResponseBytes` for its response body. |
| `datagram-budget` | A UDP flow carried `limits.maxUdpDatagramsPerFlow` datagrams (both directions together). |
| `consumer-budget` | The consumer reached `limits.maxBytesPerConsumer` for the window while this connection was open. |
| `idle` | Nothing moved for `limits.idleMs` (a UDP flow: `limits.udpIdleMs`). |
| `time-budget` | The connection lived `limits.maxDurationMs` (a fetch: `limits.maxFetchDurationMs`). |
| `stream-abuse` | The consumer broke more stream rules than the provider allows, and was cut off. |
| `origin-error` | The destination reset or failed the connection. |
| `consumer-left` | The consumer closed or cancelled its end, or its channel closed. |
| `up-timeout` | The consumer did not open its sending stream within `limits.upWaitMs` of the answer. |
<!-- ends-table:end -->

**What a consumer reports when the link itself failed:**

<!-- link-codes-table:begin -->
| Code | Meaning |
| --- | --- |
| `provider-not-authorized` | The provider has not granted this pod the `egress` protocol (`protocol:egress:open`). |
| `provider-no-egress` | The provider does not serve the `egress` protocol. |
| `provider-version` | The provider speaks no version of `egress` this package does. |
| `provider-timeout` | The provider did not answer in time. |
| `provider-unreachable` | The provider is not reachable over a direct link; routed delivery is not supported. Also what a failure to open the channel is called when none of the more exact codes below names it. |
| `provider-not-found` | This pod has no link to the provider and nothing was found at that pod id: the id is wrong, the provider is offline, or no connection was made first. |
| `provider-refused` | The provider's channel service refused the link before any question about this protocol (it takes no more peers, or its operator accepts none). |
| `signalling-unreachable` | The signalling server could not be reached, so the provider could not be looked for (said by the browser entry's `connect`). |
| `provider-pin-mismatch` | The channel is bound to a different pod than the one named; refused. |
| `provider-closed` | The channel to the provider closed. |
| `provider-gone` | Nothing was heard from the provider for the keep-alive window (`keepAlive.misses` intervals): it was killed or cannot be reached. What was open ended with this code. |
| `provider-no-form` | The provider does not know this form of request (it is older than the form). |
| `datagram-too-large` | The datagram is larger than the provider's bound for one (`limits.maxDatagramBytes`, or the flow's answered bound). |
| `bad-answer` | The provider answered with something this package cannot read. |
| `connection-ended` | The provider ended an open connection; `reason` is one of the END_REASONS. |
| `link-closed` | This link was closed locally. |
| `too-many-connections` | This link already has `limits.maxConnections` connections open. |
| `aborted` | The caller's signal aborted the call. |
<!-- link-codes-table:end -->

What a consumer reads from a provider is bounded and filtered: a code it does not know is `unknown`, an extra field is
dropped, a `budget` or `addressClass` that is not on the lists is dropped, an end reason it does not know is ignored, and
an address list that is not at most 16 IPv4 strings is `bad-answer`.

## No chaining

A provider dials from its own network and only from it. A request must carry `hops: 0`; anything else is
`chaining-refused`, as is a destination that is a mesh pod id (a pod id is an address on the mesh, never on a network).
The consumer refuses a pod id, or the provider's own id, as a destination before it sends anything, in `connect`, `lookup`
and the backend. `createMeshEgress` throws at construction if its `dial` or `resolve` is an egress consumer (a link's
`connect` or `lookup`, or a backend: they carry the `EGRESS_CONSUMER` brand), and a `dial` that returns anything that is
not a network socket is a failed connect. The brand check is a guard against a mistake, not against an operator who wraps
a consumer on purpose: the operator is trusted with `dial`.

## Audit and meter

`onAudit(record)`, one call per event, `at` the clock's `now()`:

| `event` | When | Fields |
| --- | --- | --- |
| `egress-open` | a connection, flow or fetch was made | `peer`, `form` (`tcp`, `udp` or `fetch`), `host`, `port`, `address`, `addressClass`, `via` (`exact`, `host`, `set`, `wide` or `resolved-name`), `outcome: 'opened'`; `resolved-name` (an address taken for a name) also `name`; a fetch also `method`, `status`, `redirects`, `pathLength` |
| `egress-hop` | a fetch's hop was answered | `peer`, `form: 'fetch'`, `hop`, `method`, `host`, `port`, `address`, `addressClass`, `pathLength`, `status`, `outcome: 'hop'` |
| `egress-close` | it ended | the same, plus `bytesUp`, `bytesDown`, `durationMs`, `reason` (an end reason), `outcome: 'closed'`; a UDP flow also `datagramsUp`, `datagramsDown`, `droppedUp`, `droppedDown` |
| `egress-refused` | a request was refused | `peer`, `form`, `host`, `port`, `code`, and `budget`, `addressClass` or `detail` where the code defines one, `outcome: 'refused'` |
| `egress-resolve` | a lookup was answered | `peer`, `form: 'dns'`, `host` (the name), `addresses` (a count), `durationMs`, `outcome: 'answered'` |
| `egress-abuse` | a consumer was cut off | `peer`, `reason`, `outcome: 'closed'` |
| `egress-consumer-gone` | a consumer was heard from in no way for the keep-alive window; its channel and connections were closed | `peer`, `reason: 'consumer-gone'`, `outcome: 'closed'` |

`address` is the checked address that was dialled, so an operator can answer "which of your consumers connected to X at
time T". There is never a header, payload byte or lookup answer; the path and query of a fetch are there only as lengths,
unless the operator chose `auditUrls: 'path'` (adds `path`) or `'full'` (adds `query` too), and then they are the only
contents an audit line can carry.

`onMeter(record)` is the hook for billing or quotas, with no payment logic in the package: `{ peer, form: 'tcp' | 'dns' | 'fetch' | 'udp',
connections, bytesUp, bytesDown, durationMs, reason, final }`. `final: true` is the one record of a connection (with
`connections: 1`) or a lookup; a connection longer than `meterIntervalMs` also sends `final: false` deltas
(`connections: 0`) so the sums add up. **No destination is in it**, so a meter can be handed to another party without
leaking the audit. A deployment wires it to the pieces it has, for example
`onMeter: (r) => enforcer.recordUsage(r.peer, 'egress.bytes', r.bytesUp + r.bytesDown)` with the apps package's
`QuotaEnforcer`.

## Defaults and the checks, in the order a request meets them

1. The protocol host: `protocol:egress:open`, default deny, re-asked for every message of the channel (so a revocation
   closes the channel on its next one), then `allowFrom`.
2. The request's shape (`bad-request`), its destination syntax (`bad-destination`), the provider's state
   (`shutting-down`), `hops` (`chaining-refused`).
3. The rate budgets (`connect-rate`, `connect-rate-global`, `dns-rate`), which count refused attempts too.
4. The grant (`no-grant`, `wide-not-acknowledged`), then `verifyRequest`, the blocked ports (`port-blocked`), `deny`, the
   consumer's byte budget and the connection caps. **Nothing about a destination is looked up before step 4 says yes.**
5. Resolution and the address policy (`destination-refused`, `name-not-found`, `lookup-failed`), then the connection.
6. While it lives: the byte, idle and duration budgets, the registry (`recheck`), and the stream layer's rules.

## What is not defended

- **What a granted destination does with the bytes**, including a granted host that forwards them elsewhere.
- **The provider's operator seeing destinations, sizes and timing**, and plaintext for a protocol with no TLS. A grant is for
  an address, not for what is said inside the stream: the provider does not look inside, so there is no per-name policy
  inside TLS.
- **A provider that is honest but run by someone you should not trust.** The consumer pins the provider's pod id; TLS inside
  the stream detects altered bytes; the provider's lookup answers are not an identity.
- **A consumer that is itself compromised**, within its grants and budgets.
- **Traffic analysis** by the provider or a hop.
- **Confidentiality across a relayed link.** The protocol is for direct links, as ingress; routed delivery would need sealing
  end to end and is not designed here.
- **Availability.** A provider can be stopped, rate-limited or blocked by its network; connections do not survive it.
- **The mail-port block is a default, not a guarantee** about what other ports carry.
- **IPv6 destinations.** An IPv6 literal is not accepted in this version, and a name resolves to IPv4 addresses (the dial
  itself may use an IPv6 answer).
- **Bytes per second.** There is a byte budget per connection and per consumer per day, not a rate.
- **The legal and operational exposure of an operator** beyond what is listed above.

Threat model and what is verified how: [`docs/security.md`](../../docs/security.md#egress). Design:
[`docs/design/egress.md`](../../docs/design/egress.md). The scopes next to wsh's capabilities:
[`docs/capability-notation.md`](../../docs/capability-notation.md#egress-scopes).

## Wire

Protocol `egress` v1 on a protocol channel; bodies are protocol streams, there is no framing of its own beyond a UDP flow's
datagram frames.

```
request  connect  { cid, host, port, hops: 0, nonce?, sig? }  -> { ok: true } | { ok: false, code, budget?, addressClass?, detail? }
stream   meta { cid, kind: 'down' }   provider -> consumer, opened BEFORE the answer
stream   meta { cid, kind: 'up' }     consumer -> provider, opened after the answer
request  resolve  { name, type: 'A', hops: 0, nonce?, sig? }  -> { ok: true, addresses: [string] } | { ok: false, code, ... }
notify   end      { cid, reason }     provider -> consumer, before it aborts the streams of a connection it ended
request  ping     {}                  either way, every keepAlive.intervalMs -> { ok: true }; an older peer answers method-not-found, which is
                                      an answer (added after 0.2.0; protocol version still 1)

request  fetch    { cid, url, method, headers: [[name, value]], body: boolean, redirect: 'follow' | 'manual', hops: 0, nonce?, sig? }
                  -> { ok: true, status, statusText, headers: [[name, value]], url, redirected } | { ok: false, code, ... }
                  `down` (the response body) is opened BEFORE the answer; when `body` is true the consumer opens `up` (the request
                  body) right behind the request, not after the answer
request  udp      { cid, host, port, hops: 0, nonce?, sig? }  -> { ok: true, maxDatagramBytes } | { ok: false, code, ... }
                  `down` opened BEFORE the answer, `up` after it; a datagram is a frame: a 2-byte big-endian length, then the payload
```

The protocol host's own close notification (`mesh.protocol.close`, in the apps package) gained one optional field after 0.2.0: `{ name,
reason? }`, short plain text, which is what `link.closeReason` is read from. A peer without the field ignores it.

Ending a stream is the half-close; cancelling it is a destroy; closing the channel or revoking a grant ends every
connection. A peer without the protocol answers the open with `unknown-protocol` (or not-authorized) and is sent nothing
else, so an older peer is never sent something it would mis-handle.

## Not in this version yet

The forms and the command line of the first version are all here. What is left:

- **UDP in a guest's network backend.** A container engine's guest kernel talks to its host through a network backend interface
  that has no datagram method, so a guest's UDP cannot be routed through `link.udp` yet. That is upstream of this repository
  (the engine and its kernel); this package's UDP form works for a page's own code and for anything that can call it.
- **An adapter example** from `link` to a callback-style TCP backend with pause and resume, for a container engine.
- **Connection reuse and HTTP/2 in the fetch form**: each fetch is one connection, HTTP/1.1, closed after the response.
- **Changing the grants of a running command-line provider**: edit the file and restart (an embedder has the registry, which
  can grant and revoke live).
- **IPv6 destinations** (see "What is not defended").
