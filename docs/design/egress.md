# Egress: a pod that lends its network access to peers

Status: research and design for [#379](https://github.com/johnhenry/browsermesh/issues/379), written 2026-11-25 against
`main` and `@johnhenry/wsh` 0.54.1. **Option (ii) is built, stages 1 to 4**, as `@johnhenry/browsermesh-egress` (TCP connect
and A lookup, grants, destination sets, wide mode, budgets, audit, metering, revocation, no chaining, a consumer with a netway
backend; then the fetch form, UDP, the `browsermesh-egress` command and a browser spec); what the package does is in its README
and in [security.md](../security.md#egress). The rest of this page is the design as it was written and is kept as it was,
except where the owner's decisions and the building replaced it:

- The package is `@johnhenry/browsermesh-egress`.
- A wide "any public destination" mode exists, only behind the provider operator's explicit acknowledgement
  (`wide: { acknowledge: 'any-public-address' }`), modelled on the relaying pod's wildcard rule; private, loopback,
  link-local, unique-local, carrier-NAT and metadata space stay refused in it, and only the operator's own `allowPrivate`
  admits private space, never a peer's grant (section 4.2 and 4.3 as built).
- The provider's address check is wsh's own, `@johnhenry/wsh/address-guard` (wsh 0.55.0): section 3.2's options (A) and (B)
  are replaced by it, behind a `dial` / `resolve` seam (`nodeDialer` on `./node`).
- The first version includes TCP, DNS, the fetch form and UDP, in one package; all four are built.
- **The fetch form, as built (stage 3, section 4.5):** the provider is the HTTP client (the note's choice; a page has no
  TLS stack), so the provider sees the URL, headers, bodies and responses, and the README, `security.md` and the CLI's dry run
  say so. Its own scope per origin (`egress:http:<host>:<port>:fetch`; a TCP grant is not one), offered only when the provider
  is given an `exchange` (`nodeDialer().exchange`: Node's `http` over the guard's checked socket, `tls` with the NAME as SNI;
  the one file that terminates TLS). The note's budgets are the defaults (1 MiB request body, 8 MiB response, 30 s), the audit
  has the length of the path and query and the opt-in `auditUrls: 'path' | 'full'` adds them, redirects are each a new
  request authorised against the consumer's own fetch grants (so the redirect to a destination without a grant is
  `redirect-refused` before any lookup), GET and HEAD by default and POST and the other methods only when the operator lists
  them (CONNECT and TRACE never), and the headers are allow-lists in both directions.
- **UDP, as built (stage 4, the owner wanted it):** one flow per destination as two streams carrying datagram frames (a
  2-byte length and the payload), over a datagram socket connected to the checked address (wsh's `dialUdpChecked`: the kernel
  drops every other source). Datagram semantics are stated: over the mesh the flow is reliable and ordered, beyond the provider
  the network keeps UDP's, and the provider drops, silently and counted, what it will not pass on. The note's "wsh's bounds"
  became: 8 flows per consumer, 500 datagrams a second per consumer (both directions), 1472-byte datagrams, 30 s idle, 50 000
  datagrams and 16 MiB a flow. **Amplification, decided:** replies are bounded by what the consumer sent: each datagram sent
  earns `max(4096, 8 * size)` bytes of reply credit (held up to 256 KiB), a reply over the credit is dropped, a flow starts with
  none, and a provider holds at most 64 KiB of replies for a consumer that is not reading. Port 53 is refused for every grant
  (DNS is its own form, with its own grant and rate), wide mode included.
- **Compatibility, as built:** protocol `egress` stays version 1; `fetch` and `udp` are new request methods, so an older
  provider answers them method-not-found (the consumer says `provider-no-form`) and an older consumer is never sent anything it
  does not know (the package pins 0.1.1's messages in a test and was run against the published 0.1.1 in both directions).
- **The command and the browser spec, as built (stage 2):** `browsermesh-egress` (a JSON grants file, `--dry-run`, wide mode
  only with `--wide --acknowledge-wide any-public-address`, never from the file) and `tests/browser/egress.spec.mjs` (a page
  as the consumer against a Node provider on real WebRTC, in Chromium, Firefox and WebKit). The adapter example for a container
  engine is not built.
- Choices made while building, where the note left room: a name whose answers mix a refused address with a permitted one is
  refused whole (`refuseMixed`); the blocked ports (25, 465, 587) are absolute for every grant and wide mode keeps them
  (the note let an exact-port grant override them); a `*.suffix` in a set needs at least two labels after the star; sets
  cannot hold a bare wildcard; IPv6 literals are not accepted in this version; no `admit` hook.
- Section 6.4's item 6 is done: `docs/capability-notation.md` and `docs/wsh-and-browsermesh.md` say that gateway rights are
  never granted from mesh trust and that the `egress:*` scopes are the narrow, operator-written exception.

The mirror of [`@johnhenry/browsermesh-ingress`](http-ingress.md). A peer that cannot reach the open network (a browser tab:
no raw sockets, bound by CORS) borrows the access of a peer that can (a pod in Node, or anywhere with sockets).

How to read the marks. Every statement about code or tests that exist today ends with **(V)** if I read the lines named
(or ran the thing, where the text says so) or **(I)** if it is inferred from reading around them, a document, or a name,
and not checked in the code. A statement with no mark is a design decision or a requirement, not a fact about today's
code. Line numbers are for `main` at the time of writing.

## 0. The short version

1. **Today a mesh peer can reach the network through a peer in three ways, and none is a general egress service.**
   `MeshRelayHost` shares a *named, fixed* address of the host's own `VirtualNetwork`; `WshRelay` carries a sealed wsh
   session to a *named machine* the operator mapped; `createProxyHandler` / `ServerSharing` fetch from *one configured
   origin*. In each, the peer never names a destination, which is why each is safe, and why none serves a container that
   wants to open TCP to any address.
2. **The one piece that does take a destination, netway's `GatewayBackend`, could not carry real traffic against a current
   wsh host when this survey was made (issue #381, since fixed).** It ignored wsh's `gateway-credit` flow control, so a
   connection stopped after 256 KiB received and closed after about 256 KiB sent. I ran this against the real in-memory wsh
   0.54.1 host: 262 144 bytes arrived of 2 MiB, and an upload was closed by the host after 458 752 bytes had been written,
   262 144 received by the origin; the wsh client's own `openTcp` moved 2 MiB each way through the same host **(V, section
   1.1)**. Every real-host test then moved a few bytes, which is why nothing caught it. The fix honours the credit in both
   directions and the real-host test now moves 4 MiB each way. Its UDP is send-only: replies are never read, and that
   stays, stated in the package README **(V)**.
3. **The first consumer (a container engine in a tab) needs far less than Wisp or a socket API:** TCP connect to an
   address, with half-close and pause/resume backpressure, and DNS A lookup. No UDP. It already has a pluggable network
   backend, so nothing needs to speak Wisp **(V, section 2)**.
4. **Recommendation:** a thin `@johnhenry/browsermesh-egress` mirroring ingress (option ii), TCP and DNS first, on a new
   protocol `egress` v1 on the protocol seam, per-destination grants in the registry, the provider's address policy taken
   from wsh's gateway rather than rewritten, off by default everywhere. Fix `GatewayBackend` separately (it matters today
   to `MeshRelayHost` users). The fetch form and UDP come later; a Wisp front end only if an existing Wisp client must be
   served. Section 6 has the stages and the decisions that are the owner's.

## 1. Survey: what gives a peer outbound network today

### 1.1 netway's `GatewayBackend` over a wsh host's gateway

Package `@johnhenry/browsermesh-netway` 0.3.0. A `Backend` that turns `connect`/`resolve`/`sendDatagram`/`listen` into
wsh gateway control messages sent through a `WshClient`, so a host with a gateway does the real TCP, UDP and DNS.

| Covers | Where | Mark |
| --- | --- | --- |
| TCP connect: `OPEN_TCP` (0x70), a `StreamSocket` pair, a pump from the relay half to `GatewayData` | `packages/browsermesh-netway/src/gateway-backend.mjs:103-149`, `:259-284`, `:307-317` | V |
| DNS: `RESOLVE_DNS` (0x72), answers `string[]` of the requested type | `gateway-backend.mjs:229-249`, `:392-399` | V |
| UDP: `OPEN_UDP` (0x71), wait for OK, send ONE payload, close the flow. `sendDatagram` returns `Promise<void>`; no reply is ever read | `gateway-backend.mjs:197-217`, `:318-329` | V |
| No UDP receive: `GatewayBackend` has no `bindDatagram`, the base class throws | `gateway-backend.mjs` (no such method), `src/backend.mjs:71-73` | V |
| Reverse listen (`LISTEN_REQUEST`, `INBOUND_OPEN`) | `gateway-backend.mjs:161-182`, `:363-381` | V |
| Offline operations queue (256, drained on reconnect); 30 s per-operation timeout | `gateway-backend.mjs:35`, `:83-108`; `src/constants.mjs:24-30` | V |
| Host refusals become typed errors; the `GATEWAY_ERROR` codes 1-8 mirror wsh's table (4 policy, 5 disabled or an older timeout, 7 queue full, 8 timeout) | `gateway-backend.mjs:333-352`; `src/constants.mjs:48-57`; wsh README line 447 | V |

**What it enforces itself: nothing about destinations.** Its policy is `VirtualNetwork.scope({ capabilities, policy })`:
capability tags (`tcp:connect`, `udp:send`, `dns:resolve`, `*`, ...) checked in a `ScopedNetwork` before the call
(`src/virtual-network.mjs:194-196`, `:248-254`, `:265-270`, `:301-306`, `:335-338`; `src/policy.mjs:74-91`). A tag carries no
host or port. A `policy` callback receives `{ capability, address }` and has final say (`policy.mjs:81-84`), so a caller can
write a destination filter, but the package ships none, and the scope is local to one process and keyed by an opaque scope
id, not a peer (`policy.mjs:16-19`) **(V)**. The destination policy that actually bites lives on the wsh host (1.4).

**Flow control: was broken against a current host; fixed by the change that closes #381.** The text from here to the end of
this subsection is the survey as it was made, before the fix; what the backend does now is in the netway README
("Flow control"). The wsh client lists `gateway-credit` in every `Hello`
(`@johnhenry/wsh` `src/client.mjs:727`, `:3139`) **(V)**; with it, each direction of each connection starts with 256 KiB of
credit that the receiver returns as it consumes (`src/gateway-channel.mjs:1-25`) **(V)**. `GatewayBackend` drove the raw
0x70-0x7e messages: it had no case for `GatewayCredit` and never sent one **(V)**. So a current host (a) stopped sending
after 256 KiB per connection and (b)
closed a connection whose client sent past the credit it was given (`gateway-channel.mjs:6-12`). I ran it: a scratch
script (not committed) built the same real host the netway real-host test builds (`createWshServer` with a gateway, joined
to a real `WshClient` by an in-memory socket pair; `gateway-real-wsh.test.mjs:63-97`), a local TCP origin that sends 2 MiB,
and compared `GatewayBackend.connect` with the client's own `openTcp`:

| Path through the same real host | Origin to client | Client to origin |
| --- | --- | --- |
| `GatewayBackend.connect` | 262 144 of 2 097 152 bytes, then nothing | write rejected "Socket is closed" after 458 752 bytes written; origin received 262 144 |
| wsh client `openTcp` | 2 097 152 | 2 097 152 |

**(V, run in this task.)** This was a bug in a published package, found by this survey (issue #381). It is fixed in
netway (section 6, stage 0 is done): the tables above are the "before".

**What has been run against a real host, and what only against a mock.**

- Mock `wshClient`: the whole of `test/gateway-backend.test.mjs`, including every UDP test (`:418-470`: OPEN_UDP, data,
  close; and a failure) **(V)**.
- Real wsh host (`createWshServer` from `@johnhenry/wsh/server` and `createMemoryHost`, joined to a real `WshClient` and a
  real Ed25519 login by an in-memory socket pair, **not a network connection**, to a local TCP echo): TCP connect and data
  both ways (a few bytes), close from either end, policy refusal, connection refused, name not found, `resolve`, a connection
  cap, listen. **At the time of the survey: no UDP, no large transfer, no browser.** Since the fix for #381 the same file
  also moves 4 MiB each way with every byte checked, runs a slow reader on each side, and sends one UDP datagram to a real
  UDP socket; there is still no browser run and the Rust `wsh-server` was not run **(V,
  `test/gateway-real-wsh.test.mjs`; `docs/wsh-and-browsermesh.md`)**.
- Timeout (code 8), an older gateway's 5, HOST_UNREACHABLE and CLOSED: mock and the exported code table only **(V,
  `docs/security.md:60`; `gateway-parity.test.mjs`)**.
- Browser: nothing for netway's gateway in `tests/browser/` **(V, listing)**.

`VirtualNetwork.resolve` swallows every backend error and returns `[]` (`virtual-network.mjs:173-181`), so a failed lookup
and a name that does not exist look alike through it **(V)**.

### 1.2 `MeshRelayHost` and `createMeshRelayBackend` (`browsermesh-apps`): a peer shares its network by name

A pod shares its own `VirtualNetwork` with named peers. `exposeService(name, targetAddress)` maps a name to ONE address
(`mem://localhost:8080`, or a `tcp://` address routed through a `GatewayBackend`); the peer asks for the *name*
(`packages/browsermesh-apps/src/mesh-relay-host.mjs:210-217`, `:384-408`) **(V)**. The peer never supplies an address, so this is
not an open proxy and cannot be aimed at a destination of the peer's choosing.

- Covers TCP only. `listen`, `bindDatagram` and `resolve` are left unimplemented on the client backend
  (`src/mesh-relay-backend.mjs:12-23`) **(V)**.
- Policy: default deny, `registry.checkAccess(peer, 'mesh-relay:<service>', 'connect')` (`mesh-relay-host.mjs:275-278`);
  the connection ends when that stops being true, on `registry.onAccessChange`, on `recheck()` and on a 30 s interval
  (`docs/security.md`, "Relay (`mesh-relay`)") **(V)**.
- Limits: 16 connections per peer, a 256 KiB window per connection with credit frames, 1 MiB unconsumed per connection and
  4 MiB per peer, 64 KiB frames (`src/internal/relay-flow.mjs:20-32`) **(V)**. No byte total, no time budget, no rate.
- Not confidential: bytes travel base64 in JSON envelopes and are readable by any peer that forwards them
  (`docs/security.md`, same section) **(V)**. Audit: `onLog` lines only (`mesh-relay-host.mjs`, `this.#onLog(...)` calls) **(V)**.
- Run: unit with in-memory services; `test/real-peer/mesh-relay.test.mjs` runs it over real WebRTC, with the "wsh" half a
  hand-written double with real local sockets behind it (`:99`, `:211-231`), **not a real wsh host**; never in a browser **(V)**.
  Because its gateway half is the same `GatewayBackend`, it had the 256 KiB limit of 1.1 whenever the shared service sat
  behind a real wsh host; that limit is gone since the fix for #381 **(I: follows from 1.1; not run through this path)**.

### 1.3 `WshRelay`: a pod carries a sealed wsh session to a named machine

`packages/browsermesh-transport/src/wsh-relay.mjs`, design in [`wsh-over-mesh.md`](wsh-over-mesh.md). A pod moves opaque
bytes between the requester's `wsh-relay` protocol channel and a leg: another pod's `wsh` services, or a **name the operator
mapped to a pipe relay URL and rendezvous id** (`:35-40`, `:234-269`) **(V)**. The requester pins the target's host key and the
session is sealed end to end, so the relay cannot read it **(V, `wsh-over-mesh.md:79-126`)**.

- Policy: `protocol:wsh-relay:open` plus `wsh-relay:<target>:open` for that exact target, asked per session and again on
  every registry change (`:138-143`); a wildcard grant is refused (`wildcard-grant`, `:156`) and a wildcard `targets` entry
  refused at construction (`:82`) unless `wideTargets: true` **(V)**.
- Limits: `maxSessions` 2, 64 MiB per session in both directions, one hour, five idle minutes (`:35-40`); no chains (`hops`
  marker, `:150`); `start()` needs an `indicator` or `unattended: true` (`:109-112`); audit events `relay-open`,
  `relay-refused`, `relay-close` (pod ids, target, bytes, duration; no content) **(V)**.
- Gateway through it: the relay carries any wsh session to a named machine, and the client side returns the real `WshClient`
  (`connectWshServicesViaRelay` returns `conn.client`, `:279-327`; the test asserts `conn.client.sessionSealed`,
  `wsh-relay.test.mjs:355`). So a consumer holding `wsh-relay:<name>:open`, and a key authorised on a machine whose wsh host
  has a gateway, could pass `conn.client` to `new GatewayBackend({ wshClient })` and reach the network through that machine
  **(I: nothing runs this; the test's machine host is a `createMemoryHost` with `capabilities: []` and no gateway, `wsh-relay.test.mjs:344`)**.
  It would have met the 256 KiB limit of 1.1 (fixed since), and it meets the relay's 64 MiB and two-session limits.
- Run: in memory with real registries and the real wsh client; three real WebRTC peers; **not in a browser** **(V,
  `docs/security.md:383-408`)**.

`WshServices` on a pod serves objects and MCP only: no exec, files, **gateway**, or endpoint, by design
(`docs/design/wsh-services-on-a-pod.md:6`, `wsh-over-mesh.md:73`) **(V)**. A pod does not today serve a wsh gateway to a mesh
peer.

### 1.4 The wsh gateway itself (what sits under 1.1 and 1.3)

From the `@johnhenry/wsh` 0.54.1 README and source **(V, lines named)**:

- **TCP and DNS**: `gateway: { allow, allowPrivate, socks, maxConnections, ... }`, default deny; `allow` takes `"*"`,
  `"host"` or `"host:port"` (README 466-472). `allow: ['*']` is "an open proxy to the internet for every authorized client"
  (README 2814-2816).
- **The resolved address is checked, not only the name** (README 536-543, 2750-2754): the host resolves once, refuses every
  address that is not globally routable (loopback, private, link-local, CGNAT, ULA, multicast, reserved, IPv4 wrapped in
  IPv4-mapped, NAT64 or 6to4), and **connects to the address it checked** (`src/server/gateway.mjs:199-234`
  `resolveChecked`, `dialChecked`). Private space is reached only by operator rule: `allowPrivate`, or an `allow` entry that is
  itself an IP literal. `ResolveDns` answers are filtered the same way. The Rust server has the same rule in the release after
  `rust-v0.6.0` (README 2580).
- **UDP**: `openUdp` is ONE destination fixed at open, the socket is `connect()`ed to the checked address, same name and
  address rules; bounds: 16 flows per client, 500 packets per second per flow, 2000 per client, 4 MiB/s per client both
  directions, 60 s idle; over WebSocket every datagram rides the reliable control stream; `socks` refuses UDP (README 474-507, 2761-2767).
- **Flow control**: 256 KiB credit per direction per connection when both ends list `gateway-credit`; without it, 4 MiB per
  connection and 32 MiB per client buffered, then the connection is closed (README 544-550).
- **Connection limits**: `maxConnections` 32 per client connection, connect timeout 15 s (`gateway.mjs:65`, `:240`).
- **Failure table**: `GATEWAY_FAIL` 1 refused, 2 host unreachable, 3 DNS failed, 4 policy denied, 5 gateway disabled (or an
  older Node gateway's timeout), 6 closed, 7 queue full, 8 timeout, exported and mirrored in netway (README 447-451;
  `constants.mjs:48-57`).
- **Per-key capabilities**: `gateway:tcp:<host>:<port>`, `gateway:udp:<host>:<port>` in an `authorized_keys` line or returned
  by `authorize()`, with `*` and `*.suffix` hosts (README 392-404); they do not cover sessions already open (README 2592).
  Key options such as `restrict` do not scope the gateway (README 2719-2724).
- **Not exported**: the address guard and `dialChecked` are inside `src/server/gateway.mjs` and `address-guard.mjs`; the
  `./server` entry exports `createWshServer` and a few others, not these (`src/server/index.mjs:27-30`) **(V)**. A pod that wants
  wsh's address rule gets it by running a wsh host, not by importing a function.
- **Not mesh-granted today**: the capability table says `gateway:*` "is never granted from mesh trust" and has no mesh scope
  (`docs/capability-notation.md`, table last row; `docs/wsh-and-browsermesh.md:107`) **(V)**. Egress is a deliberate, narrow
  new mesh scope (section 4), not a translation of those, and the owner should say so in those two pages when it is built.

### 1.5 Fetching: `createProxyHandler`, `ServerSharing`, `createBrowserMeshFetch`

- `createProxyHandler({ targetOrigin, checkAccess | public })` (`packages/browsermesh-apps/src/serverless-proxy.mjs:100-219`) and
  `ServerSharing` (`src/peer-routing.mjs:739-`) fetch from **one origin the operator configured**; the peer supplies a path
  (`internal/request-target.mjs:110-128`: plain absolute path, same origin, no `//`, no fragment); redirects are never followed;
  method and header allow-lists; 8 MiB response, 1 MiB request, 30 s; access by `registry.checkAccess(peer,
  'server-share:<name>' | 'serverless-proxy:<host>', 'request')`, default deny, and the handler throws at construction with
  neither a check nor `public: true` **(V)**. Bodies are buffered, not streamed. Plain `fetch`, **no resolved-address check**
  (`serverless-proxy.mjs:187`): safe because the operator chose the origin, unsafe if the origin were ever a peer's choice.
  Unit-tested against real loopback servers, never in a browser (`docs/security.md`, "Shared servers") **(V)**.
  This already answers "a browser peer fetches from *this one named origin* what CORS blocks", with a per-origin grant
  and no new code, for an operator willing to run one handler per origin.
- `createBrowserMeshFetch` (`src/mesh-fetch.mjs:12-93`) is a `fetch`-shaped call to a `mesh://<pod>/path` URL over mesh-rpc,
  buffered and bounded; it addresses a pod, not the internet **(V)**. Its shape is what a consumer-side `fetch` should mirror.

### 1.6 What is already adjacent, and not egress

- **Ingress** is the opposite direction (real HTTP in, a pod answers) and states it is "not an egress proxy: it never fetches
  a URL, and a peer never supplies one" (`packages/browsermesh-ingress/README.md:24-25`) **(V)**. Egress is the only place a
  peer-supplied destination is acceptable, and only under the rules of section 4.
- **Hosted pods** put a per-pod nft table around a *guest* (default deny, source pinned, egress only to public addresses
  unless the operator lists a destination; `docs/design/hosted-pods-security-review.md:37`). It is a network policy for a
  guest, not a service for peers, but it is the same list of address classes **(V)** and the right second layer under a provider
  run as a hosted pod **(I)**.
- Wsh-server (Rust) is listed as doing "WISP bridging" (wsh README line 2403); what that covers (whether Wisp traffic meets the
  gateway policy) is not stated and I did not determine it (section 7).

### 1.7 What is missing for a mesh-native egress service

1. A destination-bearing request on the mesh, from a peer, to a pod with sockets: nothing carries a peer-chosen `host:port`
   except `GatewayBackend` over a wsh session, and `WshServices` serves no gateway.
2. A mesh grant that names a destination. netway's tags carry none; `mesh-relay:<service>` and `wsh-relay:<target>` name
   operator-chosen things, never a destination the peer picks.
3. The resolved-address policy as a library: it exists only inside a wsh host (1.4), and in the consumer's own server as a
   separate copy (section 2).
4. Working bulk TCP through `GatewayBackend` (1.1), and UDP with replies (1.1).
5. Per-consumer budgets in bytes, time and connection rate together: `WshRelay` has bytes, time, idle and sessions;
   `MeshRelayHost` has connections and buffered bytes; none has a rate **(V)**.
6. Audit lines for connections (`WshRelay` and ingress have them; `MeshRelayHost` logs only).
7. A fetch from a peer-chosen URL with redirects re-checked; the fixed-origin proxy is as far as it goes.
8. A consumer-side shape that a container engine can plug in (sections 2 and 3).
9. Any browser run of a gateway path.

## 2. The two uses, concretely

The first consumer is a browser-tab container engine: a page that boots a kernel in a worker, runs containers in it, and
gives them a network. Its needs below were read from its own documentation and source (a private repository, described
here without names or paths). **(V for what the consumer's files say; the numbers are theirs.)**

### 2.1 What the consumer has today

- The guest's network is a user-space TCP/IP stack in the page; the page hands it a **pluggable backend object**:
  `connect({ host, port, source? }, events) -> connection` returns at once, the events are `onConnect`, `onData`, `onEnd`
  (remote half-close), `onDrain`, `onClose(error|null)`; the connection has `write`, `end` (half-close), `destroy`, `pause`,
  `resume` and `buffered` (bytes written, not yet sent); `lookup(name) -> Promise<string[]>` returns **IPv4 dotted quads**
  and rejects with code `ENOTFOUND` for a name that does not exist (anything else becomes a server failure); `close()` is
  optional. **TCP and an IPv4 name lookup are the whole interface: it has no UDP method, no IPv6, no listen** **(V)**.
- Today the backend is a **Wisp-protocol client** to a relay on the consumer's own server (`wss://.../wisp/`), TCP only (UDP
  is refused on that server), with these limits on the server: 256 streams per Wisp connection, 64 per destination host, 16
  connections per client address and 128 in all, 8 GiB per connection, a connect limit of 30 s, destination addresses
  checked to be public on the address actually dialled, mail ports 25, 465, 587 blocked, everything else public allowed "on
  purpose (containers need apt/apk/npm/http)" **(V)**.
- A second use of the server is a **registry CORS proxy** for image pulls: GET and HEAD only, a public DNS name only, every
  resolved address public and the socket connected to the checked address, redirects followed on the server (https only, at
  most 5, each hop re-checked, `Authorization` dropped when the host changes), 32 concurrent requests and 8 per client, 32
  MiB cap on non-blob bodies, inert response headers **(V)**.
- Its own tab-to-tab overlay already plugs into that backend slot: it serves addresses in a private range itself and passes
  every other destination to an inner backend (the Wisp one) **(V)**. A mesh egress backend fits the same slot with no change
  to the overlay.
- A **static export** (a folder any static host serves, no server of ours) has no relay unless one is configured; the status
  bar says "Network off", and an image not carried in the export cannot be pulled **(V)**. That is the gap #379 names.
- The guest's addresses are IPs by the time the backend sees them: the overlay classifies `NetAddress.host` as a dotted quad
  **(V)**. So a name the guest looked up through `lookup` arrives later as an IP. This matters for grants (2.2).

### 2.2 Use (a): a container engine's outbound TCP, UDP and DNS through a peer

**Minimum interface the consumer needs from an egress provider.** Not Wisp, not a socket API, not UDP:

| Need | Why | Today |
| --- | --- | --- |
| Open a TCP stream to `host-or-ip : port`; success or a coarse failure class (refused, unreachable, denied, timeout) | the backend's `connect` and `onClose(error)` | `GatewayBackend.connect` (credit-metered since the #381 fix, 1.1); `MeshRelayBackend.connect` by service name only |
| Half-close both ways | `end()` and `onEnd` | `StreamSocket.end()` exists; wsh `GatewayClose` is a half-close |
| Real backpressure: the provider stops reading the origin when the consumer stops reading, and the reverse | `pause`/`resume`, `buffered`, `onDrain`; a container pulling an image is tens of MB | protocol streams have credit (below); `GatewayBackend` has it against a host that states `gateway-credit` (not against an older one) |
| DNS `A` lookup, `ENOTFOUND` distinct from failure | `lookup(name)` | `GatewayBackend.resolve` (errors swallowed by `VirtualNetwork.resolve`) |
| At least 16 concurrent streams from one consumer, 64 from the whole mesh | the consumer's own per-peer and per-tab overlay limits are 16 and 64; a package manager opens several at once | protocol stream layer default `maxStreams` is 16 per channel (`protocol-stream.mjs:65`), configurable |
| Address information: the destination (a name or an IP) and port | what to dial and what to grant | the consumer supplies; it needs nothing back but success/failure |
| UDP | **not needed** by this consumer | |

**Flow control** to expect: the mesh's stream layer gives per-stream credit (default 256 KiB window, 32 KiB chunks); a reader
that stops reading stops the writer at one window (`packages/browsermesh-apps/src/protocol-stream.mjs:29-39`, `:63-66`) **(V)**.

**What the consumer already has that plugs in with no new code in the consumer's kernel or overlay:** the backend slot (it
takes any object of the shape above), the overlay's `inner` hook, and its own connection limits. **What is new in the
consumer, small:** an adapter from the egress consumer API to that backend shape (connect returns at once, buffers writes
until the stream opens, maps `pause`/`resume` to reading, maps `buffered` to the socket's `writableLength`); it belongs in
the consumer, or as an example in this repository's `examples/`, not in the egress package.

**The name problem, and how to meet it.** Because the guest connects by IP, a provider that grants *hosts* cannot see which
name an IP was for. Three ways, in order of preference:
1. **The consumer's adapter answers `lookup` itself with a synthetic address from a reserved range and remembers
   name-for-address** (the overlay already does this for peer names, 198.18.0.0/15), then sends the *name* to the provider on
   `connect`. The provider resolves the name itself and checks and dials its own result; it never trusts an address the
   consumer sent for a granted name. A program that connects to a literal IP (no lookup) has no name, and falls to way 2.
2. **Grants and sets that name addresses** (`egress:tcp:203.0.113.7:443`, or a set with a CIDR): a connect to an IP literal
   is allowed only if an IP-literal grant or set entry covers it.
3. **The "public internet" mode** (4.2), if the owner decides it exists: the provider checks every resolved address is public
   and nothing more.
Without 3 the first consumer can only do curated destinations (a registry mirror, a package host), which is a smaller product
than "containers get a network"; this is the single decision that most decides whether the consumer finds egress useful.

**Static-export honesty.** Egress removes the *traffic* proxy; it does not remove the need for the tab to find a provider.
A WebRTC link needs a signalling server (a small thing that carries keys, not traffic), or a pre-arranged direct address;
behind some NATs it needs TURN. Whether bulk transfer (an image pull) through a mesh data channel is fast enough is not
measured anywhere in this repository **(section 7)**.

### 2.3 Use (b): a browser peer fetches an HTTP(S) URL that CORS blocks

**Minimum interface:** `fetch(url, { method, headers, body, signal }) -> Response`, streamed response body, GET and HEAD
first, no ambient credentials.

- What the consumer already has: `createBrowserMeshFetch` is the right *shape* (1.5); the browser `Response` and
  `ReadableStream` are the types. For a *known* origin the existing `createProxyHandler` plus a `serverless-proxy:<host>` grant
  already do it, with no new code, one handler per origin (1.5). The consumer's registry proxy shows what a registry
  consumer needs on top: redirects (blob hosts redirect to a CDN), re-checked at every hop, `Authorization` dropped when the
  host changes, a response header allow-list, size caps (2.1).
- What is new: an arbitrary-URL fetch with a per-destination grant, the resolved-address check on the provider's own dial
  (including after each redirect), a streamed body, and the response policy of ingress mirrored (no cookies, no
  `Set-Cookie`, nosniff; the consumer's page treats the body as untrusted bytes).
- **Confidentiality is different here, and no design removes the difference.** A browser tab has no TLS client for a raw
  stream, so a page asking for `https://example.com/x` can only have the *provider* do the TLS: the provider sees the
  request line, headers and body, and the response, in the clear. In the TCP form the provider relays TLS bytes it cannot
  read. For the fetch form the grant is a statement of trust in the provider, not just in its network. Section 4.5.

## 3. Design options, compared honestly

All four keep what the issue requires: off by default everywhere, nothing existing changes, a pod with real sockets as the
provider (Node, Deno, Bun or the hosted-pod lane; a browser tab can never be one).

| | (i) No new package: document the existing path, add a mesh service handing out a wsh gateway | (ii) `@johnhenry/browsermesh-egress`, thin, mirroring ingress | (iii) Wisp-compatible provider | (iv) HTTP fetch proxy first, TCP later |
| --- | --- | --- | --- | --- |
| Serves the first consumer (TCP+DNS) | Yes, once `GatewayBackend` is fixed and an adapter exists | Yes (stage 2) | Yes, if its client can be fed a non-WebSocket carrier (below) | **No**: containers need raw TCP; serves its image pulls only |
| Serves use (b) (CORS fetch) | No (TCP only) | Yes, stage 3 | No | Yes, first |
| Reuses | `WshRelay` and `wsh` services, `GatewayBackend`, wsh gateway policy and key capabilities | the protocol seam and stream layer (as ingress does), the registry, wsh's gateway as the in-process address guard, netway sockets | everything in (ii) plus a Wisp codec | ingress's wire shapes (rid, nonce, head, streams, header allow-lists, limits) mirrored, `createProxyHandler`'s request-target rules |
| Adds | (i-a) nothing but documentation. (i-b) a `WshGatewayHost` beside `WshServices`: serve a gateway-bearing wsh host over a `wsh-gateway` channel, sealed, with registry-to-capability mapping and revocation | provider core (grants, wildcard probe, limits, audit, meter, revocation, no chain), consumer `connectEgress`, a netway `Backend` adapter, a Node dialer entry, a CLI | a Wisp v1 codec as a front end over the same core; a WebSocket-shaped shim for clients that want a URL | provider fetch with a checked dial, consumer `createEgressFetch`, response policy |
| Wire additions | (i-a) none. (i-b) one new protocol name, `wsh-gateway`; the session is wsh's, already specified | one new protocol, `egress` v1 | one more protocol name, `wisp` (raw messages) | one new protocol, `egress` v1 with only `fetch` |
| An older peer | (i-b) answers `mesh.protocol.open` with -32601 (unknown) or -32003 (not authorised); nothing else is sent to it | the same | the same | the same |
| Grant model | wsh `authorized_keys` capabilities on the machine (i-a); a mesh scope mapped to a wsh capability at login (i-b), which reverses today's "never from mesh trust" rule | mesh registry scopes per destination, one policy language | none in Wisp: a Wisp server has allow and deny lists only | mesh registry scopes per host and port |
| Confidentiality | sealed end to end (wsh session, pinned to the pod key), also over relayed links | the protocol channel on a direct link (DTLS on WebRTC); not sealed beyond the link, direct links only in v1, as ingress | as (ii) | as (ii); the provider sees plaintext by construction |
| Provider's operator exposed to | their address as the source of whatever the consumer opens; no content in the TCP form | the same; plus plaintext in the fetch form | the same, with a weaker policy language | plaintext of every fetch, their address on every URL |
| Effort | (i-a) 0.5 stage. (i-b) 2 stages plus stage 0 | 4 stages plus stage 0 (section 6) | (ii) plus 1 stage; **not needed by the first consumer** | 2 stages for fetch, then (ii) for TCP: more total |

### 3.1 (i) No new package

(i-a) *Document the existing composition.* An operator runs a wsh host with a gateway on a machine (Node `createWshServer`, or
the Rust `wsh-server` with `[gateway]`), registers it at a pipe relay, maps a name on a `WshRelay`, and gives a consumer pod
`wsh-relay:<name>:open` and a key authorised on the host with `capabilities="gateway:tcp:host:port,..."`. The consumer
builds `GatewayBackend` on `conn.client` (1.3). Honest status: **never run end to end** (the bulk limit of stage 0 is fixed); the
destination grant lives in wsh's key file, not the mesh registry (two policy languages, the registry grants only the
carrier session); `WshRelay` allows two sessions and 64 MiB per session, one hour; and it needs a machine wsh host plus a
pipe relay, which is a server, so it does not meet the "no server" goal in the issue. It is a legitimate interim for an
operator who already runs wsh, and costs a page of documentation.

(i-b) *A mesh service that hands a consumer a wsh gateway on a provider pod*: a `WshGatewayHost` next to `WshServices`
(`wsh-services.mjs`), serving `createWshServer({ gateway })` through `serveWshOverDuplex` on a `wsh-gateway` protocol,
sealed (`sealSession: 'require'`, key bound to the host key, `expectHostKey` the pod id, as `WshServices` does at
`wsh-services.mjs:399`), admitting only the channel peer's own key, mapping registry grants to `gateway:tcp:` capabilities in
`authorize()`, and ending a session on `registry.onAccessChange` (wsh does not cover sessions already open, README 2592; the
services host already does this, `wsh-services.mjs:253-254`). **For:** the least new protocol; sealed even on relayed links;
UDP, DNS, flow control and the failure table are wsh's own; one session carries many connections. **Against:** the consumer
carries a wsh client and its sealing in the tab and must use `openTcp`, not `GatewayBackend`; grants become wsh capability
strings with `*` and `*.suffix` hosts, so the "never a bare wildcard" rule must be enforced in the mapping rather than by
construction; it reverses the written rule that gateway rights are never given from mesh trust (`capability-notation.md`),
which is the owner's to reverse; per-consumer byte, rate and time budgets and audit are still to build, so most of the work
of (ii) remains. It is a reasonable second implementation; I do not recommend it first, because it asks more of the consumer
and of the docs for less.

### 3.2 (ii) A thin `@johnhenry/browsermesh-egress`

The mirror of ingress in shape, naming, options and posture.

```js
// provider: a pod with sockets
import { createMeshEgress } from '@johnhenry/browsermesh-egress'
import { nodeDialer } from '@johnhenry/browsermesh-egress/node'          // the only thing that touches a network
const egress = createMeshEgress({
  service, registry, podId,                    // as WshRelay: the grants are the registry's
  dial: nodeDialer({ allowPrivate: [] }),      // required. Operator-only widening of what ADDRESS classes are reachable
  sets: { 'package-hosts': ['registry.npmjs.org:443', '*.alpinelinux.org:443'] },   // operator-named destination sets
  wideDestinations: false,                     // the acknowledgement of 4.2
  limits: { ... },                             // section 4.6
  deny: (destination) => false,                // operator veto, like ingress `deny`
  onAudit: (record) => {},                     // 4.8
  onMeter: (record) => {},                     // section 5
  indicator,                                   // or unattended: true, as WshRelay.start() requires
})
egress.start()                                 // off until called; { stop(), stats(), sessions }

// consumer: any peer
import { connectEgress } from '@johnhenry/browsermesh-egress'
const link = await connectEgress(service, providerPodId, { signal })     // pinned to that pod, like ingress's mapping
const socket = await link.connect('registry.npmjs.org', 443)             // a netway StreamSocket
const addresses = await link.resolve('example.com')
const response = await link.fetch('https://example.com/feed.xml', { signal })   // stage 3; fetch-shaped
link.asBackend()                               // a netway Backend (connect, resolve) to register on a VirtualNetwork
```

Layout as ingress: a core entry with no `node:` import (a test asserts it, as ingress does), a `./node` entry (`nodeDialer`),
a CLI (`browsermesh-egress --serve --identity <file> --signaling <url> --allow ... --set ...`, exits non-zero with one
sentence on bad input), peer dependency `@johnhenry/browsermesh-apps` for the protocol channel, `@johnhenry/browsermesh-netway`
optional for the adapter, `@johnhenry/wsh` optional for the provider's address guard (below). Wire, protocol `egress` v1 on
the protocol seam (`openProtocol(peer, 'egress', { versions: [1] })`), bodies on protocol streams:

```
request  connect  { cid, host, port, hops: 0 }  -> { ok: true }   (or a refusal with a code from the wsh failure table and a reason)
stream   meta { cid, kind: 'up' }    consumer -> provider
stream   meta { cid, kind: 'down' }  provider -> consumer, opened BEFORE the answer, as ingress opens its response stream
request  resolve  { name, type: 'A' | 'AAAA' }   -> { addresses: [string] }
request  fetch    { rid, nonce, method, url, headers, body: bool } -> { status, headers, body: bool }     (stage 3)
```

`up`/`down` end is a half-close; `cancel` is a destroy; closing the channel or a revocation ends every connection. Credit
and bounds are the stream layer's. This is the shape of ingress's `http` v1 (`docs/design/http-ingress.md:132-161`) with the
direction reversed and one more stream kind; no new framing.

**How the provider dials, the one real design question.** The destination rules of section 4 (the resolved address is
checked, and the checked address is the one dialled) already exist, tested, in the wsh gateway, and are **not exported as a
function** (1.4). Two ways to get them:

- **(A) The provider runs a wsh host with a gateway in its own process, reachable only by the egress package**: an
  in-memory socket pair, a throwaway key, `allow: ['*']` on a host no peer can reach, and the egress package checking every
  grant BEFORE it calls `client.openTcp` (the credit-aware API; I showed it moves 2 MiB each way, 1.1; `GatewayBackend` now does too). The rebinding defence,
  the address classes (including IPv4-mapped, NAT64, 6to4), UDP bounds and the Rust-parity rule are wsh's, kept in one place.
  This is the setup `gateway-real-wsh.test.mjs` builds (`:63-97`) **(V)**. Cost: a wsh server and client in the provider;
  `@johnhenry/wsh` becomes a provider dependency.
- **(B) The provider dials with `node:dns` and `node:net` and its own address guard.** No wsh dependency, runs on any
  runtime. Cost: a second copy of the address-class table to keep correct (the consumer's server already has a third),
  with its own tests. A good future step is for wsh to export its guard so (B) can share the code; that is a change in the
  wsh repository, not this one, and is not required.

Recommended: **(A) for v1**, behind a `dial` seam so (B) can follow. "Grants name where; the operator's address policy says
what kind of address is ever reachable" is the rule that keeps the two layers from fighting: a peer's grant can never widen
the address classes; only the operator's `allowPrivate` can (4.3).

For and against (ii): **For** one policy language (the registry), per-destination grants by construction, one place for
budgets, audit, revocation and chain refusal, a small consumer (no wsh in the tab), and the consumer API is what a container
engine and a fetch both want. **Against:** a new protocol to specify and keep; not sealed beyond the link (direct links only
in v1, as ingress); (A) pulls wsh into the provider.

### 3.3 (iii) A Wisp-compatible provider

A Wisp client speaks packets of a type, a stream id and a payload (connect with a stream type, port and host name; data;
a flow-control "continue"; close), usually over a WebSocket URL. **I did not read the Wisp specification in this task; the
description is from memory and must be checked before anything is built** **(I)**. What I did read: the consumer's backend is
configured with a WebSocket URL, so a Wisp front end would need a WebSocket-shaped carrier (a shim object, a service worker,
or the protocol channel's raw messages with a client that accepts a custom socket class; whether its client allows that was not
determined). A Wisp server has no per-destination grants, only allow and deny lists, so the provider's policy would sit in
the front end and lose the registry's per-peer model unless the whole Wisp connection is one grant.

**It is not needed by the first consumer**, which has its own backend slot and needs no Wisp. It matters if the owner wants
*existing unmodified Wisp clients* (other projects) to use a mesh peer. Then it is a thin extra front end over the (ii) core:
a `wisp` protocol of raw messages that translates packets to `connect` and streams. Defer; build only on demand.

### 3.4 (iv) An HTTP-only fetch proxy first, TCP later

`serveFetchOnMesh` / `createEgressFetch`: the ingress wire reversed (rid, nonce, request head out, response head and a
response stream back), the grant `egress:http:<host>:<port>:fetch`, redirects re-granted and re-checked, response policy
of ingress. **For:** the smallest first step, directly answers use (b) and the consumer's image-pull proxy, and every wire
shape is a copy of one that has been through hostile-peer testing in ingress; it can be tested in Chromium immediately.
**Against:** it does nothing for containers' raw TCP, so it does not produce something the first consumer can use for the
need the issue names first; the provider needs an HTTP client that dials a checked address (Node's `https.request` accepts a
`lookup` function and connects to what it returns, so this is feasible **(I: not tried)**, or (A) of 3.2 with TLS over the
returned socket); and the provider sees plaintext, so it is the *larger* privacy decision taken first. Doing it first means
doing (ii)'s core later anyway. The fetch form is therefore best as stage 3 of (ii), reusing its grants, limits and audit.

## 4. Safety: requirements

These are requirements for any implementation, in the voice of `docs/security.md` and the relaying-pod design. Each gets a
test and each test is broken once to see it fail (the repository's rule).

### 4.1 Off by default, everywhere

1. Nothing in the repository constructs a provider; `createMeshEgress()` returns an object that serves nothing until
   `start()`, and `start()` refuses unless an `indicator` is given or `unattended: true` (as `WshRelay.start()`, `wsh-relay.mjs:109-112` **(V)**).
2. The protocol host's own gate, `protocol:egress:open`, default deny, asked again for every message of the channel, so a
   revocation closes the channel on its next one (`docs/protocol-channel.md`, "Opening by name, authorisation") **(V)**.
3. A second gate per destination (4.2). No grant for `egress:*` is created by any default template, join gate, or helper.
4. A consumer that holds no grant learns nothing about what the provider can reach: a request for a destination with no grant
   is refused with the same reason whether or not the destination is real or reachable (`no-grant`), checked before any DNS
   (the relay's rule, `wsh-relay.mjs:148-161`: "nothing is said about a target to a requester that has no grant for it") **(V)**.
5. The consumer side has no ambient state: `connectEgress` needs the provider's pod id from the caller and pins the channel
   to it (`channel.peer` equals it, else the channel is closed), as ingress pins its mapped pod (`http-ingress.md:163-177`) **(V)**.

### 4.2 A grant per destination, in the existing notation

The registry composes `${resource}:${action}` and `matchScope` compares **segment by segment, for any number of segments;
a granted segment covers a required one only if it is `*` or equal; `*` is a whole segment, never a prefix or a pattern**
(`packages/browsermesh-primitives/src/capability.mjs:32-44`; `peer-registry.mjs:459-474`) **(V)**. So a host is one segment,
which means it must not contain `:`, and a CIDR or `*.suffix` cannot be expressed as a literal grant.

| Scope (the string granted) | Meaning |
| --- | --- |
| `protocol:egress:open` | may open the protocol channel at all |
| `egress:tcp:<host>:<port>:connect` | open TCP to that `<host>` and `<port>`. `<host>` is a lowercase DNS name or an IPv4 dotted quad (no `:`, so an IPv6 literal cannot be written here; use a set). `<port>` is 1-65535 |
| `egress:tcp:<host>:*:connect` | any port of that exact host; the provider's blocked-port list (25, 465, 587, 0) still applies unless a grant names the port |
| `egress:dns:<name>:resolve` | resolve that exact name. DNS has its own scope on purpose: connecting by name does not need it (the provider resolves for the dial); a bare `resolve` is an oracle and an amplifier |
| `egress:set:<set>:connect` | connect to anything the operator-named set lists (below) |
| `egress:http:<host>:<port>:fetch` | stage 3: fetch from that host and port (scheme in the URL: `https` by default, plain `http` refused unless the operator turned it on) |
| `egress:udp:<host>:<port>:send` | stage 4: one UDP flow to that destination, fixed at open (wsh's own shape) |

Each can carry `expiresAt` (`grantCapabilities(peer, scopes, { expiresAt })`; a grant that expires is announced like a
revocation, `capability-notation.md`) **(V)**.

**Allowed destination forms.**
- *Exact host and exact port*: yes. The default and the recommended grant.
- *An exact host with any port*: yes, with the blocked-port rule above.
- *A CIDR*: **not as a literal grant** (the grammar cannot say it). Only in an operator-written set, where an entry is
  `host:port`, `*.suffix:port` (any subdomain, not the apex; wsh's own reading), `a.b.c.d/n:port` or an IP literal, never a
  bare `*`.
- *Any host on a given port* (`egress:tcp:*:443:connect`) and *any host any port* (`egress:tcp:*:*:connect`, "the public
  internet"): **never by a peer's grant alone.**

**A bare wildcard is refused unless the operator acknowledges it, as `WshRelay` does for `wsh-relay:*:open`.** For each
request the provider asks the registry about the literal-`*` forms: (host `*`, the request's port) and (the request's host,
port `*`) and (`*`, `*`). The registry matches the literal `*` only against a wildcard scope, so these probes detect
exactly the wildcard grants (`wsh-relay.mjs:156` and its comment **(V)**; the argument that probing with `*` finds only
wildcard grants follows from `matchScope` **(I)**). If a probe is allowed and `wideDestinations` is not set the request is
refused `wildcard-grant`, even if an exact grant would also cover it. A set containing a bare `*` host is refused at
construction the same way, as `WshRelay` refuses a `*` target.

**Deliberately allowing "the public internet" (if the owner decides it exists at all, section 6.4).** A wildcard is more
dangerous here than in the relay: a relay wildcard lets a peer name any *pod*; an egress wildcard turns the provider into
an open proxy for the whole network. So the acknowledgement is stronger than one boolean:
`wideDestinations: { acknowledge: 'any-public-address', maxConsumers, ... }`, plus `start()` demanding an `indicator`
or `unattended: true` (as every provider does), plus the budgets of 4.6 being mandatory (the option refuses to take
`Infinity`), plus the wide mode never overriding 4.3 (private, loopback and the rest stay refused) or the blocked ports.
The consumer's own proxy server uses the same pattern for mail ports (a second key must be turned to unlock them); that is
the precedent for one more deliberate step. **(V for the consumer's precedent.)**

### 4.3 The address a name resolves to is checked, after DNS, every time

Requirements:
1. Resolve once; refuse every returned address that is not globally routable: unspecified, loopback, private,
   link-local (including the cloud metadata address), CGNAT, ULA, multicast, reserved and documentation ranges, and IPv4
   embedded in IPv4-mapped, NAT64 or 6to4 IPv6; **connect to the address that was checked, never to the name again**
   (wsh's rule, 1.4 **(V)**; the hosted-pod table lists the same classes, 1.6 **(V)**).
2. **The provider's own addresses and its mesh are not reachable even if public.** Refuse every address of the provider's
   own interfaces (a public address of the provider hairpins to services bound on all interfaces), and the addresses of the
   signalling and relay servers it is configured with, by default and through `deny`. A peer of the mesh reached through
   the provider's public egress is just an internet host; the rule is about the provider's own surfaces.
3. **Rebinding:** because there is no second lookup and the dialled address is the checked one, a name whose answer changes
   between the check and the dial cannot redirect the connection. For the fetch form the same holds for every redirect hop
   and for any connection reuse (a pooled connection to a host whose address changed must be re-checked or dropped).
4. **A destination given as an IP literal is checked by the same code**, parsed once into a canonical address
   (decimal, octal, hex and short spellings of IPv4 are refused or normalised before any rule sees them; the consumer's
   server parses them "by their value"). A grant for an exact host does not cover an IP literal for that host.
5. **Operator widening is separate from grants:** `allowPrivate` (CIDRs or addresses) belongs to the operator's `dial`, as in
   wsh. A peer's grant can never widen the address classes; `egress:tcp:10.0.0.5:5432:connect` is honoured only if the
   operator listed that address in `allowPrivate` (wsh's explicit-IP-literal rule, README 538-541 **(V)**).
6. A refused address is refused identically whether or not anything listens there (denied before any dial), so the provider's
   LAN cannot be probed through the failure code. The failure vocabulary is wsh's table: refused, unreachable, DNS failed,
   denied, closed, queue full, timeout.

### 4.4 TLS: the provider carries bytes and does not terminate or inspect them (TCP form)

- The TCP form relays opaque bytes. The provider has no TLS code in that path, offers no interception mode, does no protocol
  sniffing, and never writes into the stream. A test pins that the bytes at the origin are exactly the bytes the consumer
  wrote, and that the egress package imports nothing from `node:tls` in the TCP path.
- The provider learns the destination (host and port) and the sizes and timing, and for TLS nothing more; for a plain
  protocol on any port it can read everything, which is the operator's exposure to know (4.9).
- **A grant is for an address, not for what is said inside the stream.** A TLS client can send any server name to a granted
  address; per-name policy inside the stream is not possible without inspecting it, and the design does not do that. A
  granted host that is itself a proxy or a relay widens the grant to whatever it forwards (4.10).
- The provider can lie in DNS (`resolve`) and can drop or alter plain bytes. The consumer's TLS stack and certificate checks
  are the defence; the consumer must not treat a provider's `resolve` answer as an identity.

### 4.5 The fetch form and confidentiality

| | TCP form (`connect`, TLS inside the stream) | Fetch form (`fetch`, the provider is the HTTP client) |
| --- | --- | --- |
| Provider sees | destination, sizes, timing | the full URL, headers, body and response |
| Consumer's page needs | a TLS client (its guest has one; a page does not) | nothing; gets a `Response` |
| Provider could alter | plain bytes only; TLS makes it detectable | anything |
| Fits "the provider is a dumb pipe" | yes | no |

So the fetch form is a different promise and must be labelled so: a grant `egress:http:...` says "I trust this peer with
this request and its answer". Requirements: GET and HEAD only to start; the audit never records the path or query (4.8); no
cookie jar and no `Set-Cookie` returned; no request headers beyond an allow-list (accept, language, content-type,
conditional and range headers, as ingress forwards); `Authorization` is forwarded only if the *consumer* put it there for a
host it trusts the provider with, and dropped on a redirect to another host (the consumer's registry proxy does this **(V)**);
redirects are followed only to destinations that are themselves granted and address-checked, at most 5, https only;
response headers pass through ingress's allow-list; size and time caps; no `Upgrade`. Where a page can use the TCP form with
its own TLS, it should prefer it; I know of no page-side TLS client in this repository **(I)**.

### 4.6 Budgets: bytes, connections, rate and time, per consumer and global

Every dimension is bounded and every bound has a named refusal or end reason, a default and a test. The numbers are my
proposals from the closest existing defaults, and the first three rows are the owner's to set (section 6.4); a limit may be
lowered by an operator but a wide-mode provider may not set one to unlimited.

| Dimension | Proposed default | Taken from |
| --- | --- | --- |
| Concurrent connections per consumer / global | 16 / 64 | consumer's overlay limits; ingress global 64 |
| New connections per minute per consumer / global | 120 / 600 | ingress `clientRate` and `providerRate` (`limits.mjs:25-26`) |
| Bytes per connection, both directions | 64 MiB, then `byte-budget` | `WshRelay` `maxBytes` (`wsh-relay.mjs:35-40`) |
| Bytes per consumer per 24 h, both directions | 1 GiB, then `consumer-budget` | new |
| Bytes per second per consumer | 4 MiB/s | wsh UDP `bytesPerSecondPerClient` (README 503-505) |
| Connect timeout / idle / duration | 15 s / 5 min / 1 h | wsh connect default (`gateway.mjs:65`); `WshRelay` `idleMs`, `maxDurationMs` |
| DNS lookups per minute per consumer | 30 | new |
| Fetch: request body / response / total | 1 MiB / 8 MiB / 30 s | ingress and `PROXY_LIMITS_DEFAULTS` (`request-target.mjs:15-22`) |
| UDP (stage 4) | wsh's: 16 flows, 500 packets/s per flow, 4 MiB/s | README 503-505 |
| Blocked ports | 25, 465, 587, 0 | the consumer's relay (V) |

A consumer's counters are in the provider, keyed by the channel's verified peer, never by a field of a message (the quota
service says the same of usage reports, `quotas.mjs:44-50`) **(V)**.

### 4.7 Revocation ends live connections

The provider subscribes to `registry.onAccessChange` and re-checks every live connection against the exact scope it was
opened under; a connection whose grant is gone, revoked or expired is destroyed with reason `revoked`, in both directions,
and its streams are cancelled (the relay's `#recheck`, `wsh-relay.mjs:138-143`, and `MeshRelayHost`'s recheck including a
30 s interval to notice expiry **(V)**). `egress.stop()` ends everything. A connection is not re-checked per packet.

### 4.8 Audit lines, without contents

Events `egress-open`, `egress-refused`, `egress-close`, as the relay's: `{ event, at, peer, form, host, port, address?,
reason?, bytesUp, bytesDown, durationMs }`. `address` is the checked address dialled (so an operator can answer a complaint
"which of your consumers connected to X at time T"). Never a URL path, query, header, cookie, body or payload byte. A sink
that throws never breaks a connection (ingress and relay wrap theirs in `try` **(V)**, `ingress.mjs:229`, `:243`).

### 4.9 No chaining through a second egress

Mirrors `WshRelay`: its leg only ever opens `wsh`, never `wsh-relay`; the control message carries `hops: 0` and anything else
is refused `chain`; a request naming the relay or the requester is refused `loop` (`wsh-relay.mjs:148-161`) **(V)**.
For egress: `hops: 0` required; the `dial` a provider is given must be a real dialer, enforced by a brand check: a
`createMeshEgress` constructed with a dial that is itself an egress consumer (or a `MeshRelayBackend`) throws at construction;
and a destination that is a pod's own signalling address or a mesh peer address the operator marked in `deny` is refused.
Test: build a provider whose dial is `link.connect` of another provider and see it refuse to construct.

### 4.10 What the provider's operator should know before turning it on

- **Their address is what destinations see.** A consumer's connections come from the provider's IP, and complaints, blocks
  and legal notices go to the provider's operator. Do not run it from a home or office connection you cannot afford to have
  blocked; prefer a separate address or a hosted pod with the nft policy of 1.6 as a second layer.
- **A grant is a statement of trust in a pod key, not a person.** A grantee's key could be compromised; the damage is bounded by
  the destinations, the budgets and `expiresAt`. Grant for a short time, a narrow set and a named peer.
- **Wide mode (if it exists) is an open proxy** for every holder of such a grant, for as long as it lives.
- **The fetch form lets the provider read everything the consumer fetches.** Operators must not log contents (the package
  logs none) and consumers should know whose pod they asked.
- **They see destinations and timing** in the audit. That is itself personal data in many places; set retention.
- **A granted destination that is a proxy, VPN or relay passes the consumer onward** to whatever it forwards; do not grant
  one you would not grant the whole network.
- **Mail ports are blocked by default** and stay blocked in wide mode.
- **Stopping the provider drops every connection**; there is no resume.

### 4.11 Threat table

In the style of `docs/security.md`: who the attacker is and wants, what stops them, and the named refusal.

| Threat | What stops it | Reason / end |
| --- | --- | --- |
| A peer with no grant opens a channel or asks for a destination | `protocol:egress:open`, default deny, re-asked per message; per-destination scope; same reason for real and unreal destinations | `not-authorized`, `no-grant` |
| A grant for one destination used for another | exact scope per host and port; the provider resolves and dials only the name in the request; an IP literal is not covered by a host grant | `no-grant` |
| A peer asks for the provider's loopback, LAN, metadata address, CGNAT or ULA, directly or through a name | the resolved address must be globally routable, checked after DNS, dialled as checked; operator `allowPrivate` is the only widening | `address-denied` (wsh code 4) |
| A name whose answer changes between check and use (rebinding) | one resolution, the checked address is dialled; re-checked for every redirect hop and pooled connection in the fetch form | `address-denied` |
| An IP address written in a non-canonical spelling | one canonical parse before any rule; non-canonical forms refused | `bad-destination` |
| The provider's own public address (hairpin) or its signalling server | refused by default and through `deny` | `address-denied`, `denied` |
| Wildcard grant turning the provider into an open proxy by accident | probe of the literal-`*` forms; `wildcard-grant` unless `wideDestinations` acknowledged; sets with `*` refused at construction | `wildcard-grant` |
| Using the provider for mail, scans or floods | mail ports blocked; per-consumer and global connection, rate and byte budgets; connect, idle and duration limits | `port-blocked`, `rate`, `byte-budget`, `consumer-budget`, `idle`, `time-budget` |
| Amplification through DNS or UDP | `resolve` needs its own grant and a rate; UDP (stage 4) is one destination, rate- and byte-limited as wsh does | `rate`, `byte-budget` |
| A revoked or expired consumer keeps a connection | re-check on every access change and on an interval; destroy in both directions | `revoked` |
| A consumer relays through a second egress to launder its origin | `hops: 0`, brand check on the dialer | `chain` |
| A hostile destination server attacks the consumer | TCP: the consumer's TLS; fetch: header allow-list, no cookies, nosniff, size and time caps, inert by default | caps named |
| A hostile provider answers wrongly, alters plain bytes or lies in DNS | the consumer pins the provider's pod id; TLS inside TCP detects alteration; `resolve` is not an identity | `provider-pin-mismatch` |
| A provider or hop impersonated on a link whose identity is only asserted | direct links only in v1 (as ingress); on an asserted link, signed requests and answers should be required by the application (ingress's hooks, `docs/security.md` HTTP ingress) | `provider-unreachable` |
| The consumer or provider is made to retain content | the audit and meter carry no content; the package logs no payload | |
| One consumer starves the others | per-consumer and global caps, fair refusal rather than queueing past a bound | `busy`, `rate` |

### 4.12 Deliberately not defended

- **A provider that behaves honestly but is run by someone you should not trust**: it sees destinations and timing, and in
  the fetch form everything. The grant is the trust decision.
- **Traffic analysis** by the provider or a hop: sizes, timing, destinations.
- **What a granted destination does**, including a granted host that forwards your bytes elsewhere.
- **Naming inside a TLS stream**: no per-name policy beyond the address.
- **A consumer that is itself compromised, within its grants and budgets.**
- **Confidentiality across a relayed (non-direct) link in v1**: the protocol is for direct links, like ingress; routed
  delivery would need sealing end to end and is not designed here.
- **Availability**: a provider can be stopped, rate-limited or blocked by its network; connections do not survive it.
- **Legal and policy exposure of the operator** beyond what 4.10 tells them.
- **The mail-port block is a default, not a guarantee** against abuse on other ports.

## 5. Metering

A hook in the shape the repository already uses, with no payment logic. Two shapes exist:

- ingress and the relay: `onAudit(record)`, a plain callback that never breaks a request (`ingress.mjs:83-92`, `:229`, `:243`;
  `wsh-relay.mjs:134-136`), records of counts and identifiers, no contents **(V)**;
- the ledger hook: `router.attachEscrowLedger((op, amount, podId, memo) => ...)`, where the pod id is the authenticated
  sender and the ledger decides (`packages/browsermesh-apps/src/payments.mjs:1443-1451`; `README.md`, "Ledger hook") **(V)**.
  For quotas: `QuotaEnforcer.recordUsage(podId, resource, amount)` and `checkQuota(podId, resource, requestedAmount)`
  (`quotas.mjs:488`, `:555`) **(V)**.

Design: `onMeter(record)` called once when a connection (or fetch, or UDP flow) ends, and for a connection longer than a
minute every minute with the delta, with `{ peer, form: 'tcp'|'udp'|'fetch'|'dns', connections: 1, bytesUp, bytesDown,
durationMs, reason }`. No destination in it (a billing sink does not need to know where), so a meter can be handed to
another party without leaking the audit. `egress.stats()` returns the same totals per consumer
(`{ peer: { connections, open, bytesUp, bytesDown, refused } }`), the way ingress's `stats()` does. The peer is the
channel's verified peer. A deployment wires it to the existing pieces by a three-line adapter
(`onMeter: (r) => enforcer.recordUsage(r.peer, 'egress.bytes', r.bytesUp + r.bytesDown)`), and may consult
`checkQuota` before a connect through an optional `admit(peer, request) -> boolean | Promise<boolean>` hook that is asked
alongside the grant check and can only refuse. The provider's counts are the provider's; a consumer keeps its own and nothing
reconciles them in this package. No amounts, prices or balances appear anywhere in the package.

## 6. Recommendation

### 6.1 What to build

**Option (ii), a thin `@johnhenry/browsermesh-egress`**, TCP and DNS first, with the fetch form as a later stage of the same
package; the provider's address policy taken from the wsh gateway in-process (3.2 (A)) behind a `dial` seam; documentation of
(i-a) now as an interim for operators who already run wsh, flagged as untested for bulk. Reasons:

1. It serves the first consumer's actual interface (a TCP backend plus A lookups) with nothing in the consumer's kernel to
   change, and answers use (b) later on the same grants and limits.
2. Its grant model is the registry's, one policy language, per destination by construction, with the wildcard rule the
   relaying pod already set as precedent. (i-b) would need the written "never from mesh trust" rule reversed and wsh
   capability strings policed.
3. It mirrors ingress closely enough to inherit its test shapes (hostile client, hostile provider, real two-peer WebRTC,
   Chromium, Firefox and WebKit) and its posture (off, default deny, bounded, named reasons, audit without content).
4. It does not depend on `GatewayBackend` (whose 256 KiB limit, 1.1, was fixed after this survey); the in-process wsh client
   uses the credit-aware `openTcp`.
5. (iv) first would produce something the first consumer cannot use for its main need, and (iii) is for a consumer nobody has
   named.

What I would **not** do: put the provider in the tab (impossible), accept a destination from a peer without a grant, or
re-export wsh's gateway through the mesh under a mesh scope without the owner reversing the written rule.

### 6.2 Staged build plan, one worker per stage

Each stage is a complete, tested slice with a changeset; nothing is on by default at any stage.

**Stage 0: fix `GatewayBackend`'s flow control (netway, patch). Done (#381): credit is honoured in both directions, UDP
stays send-only and says so, the test below is in `gateway-real-wsh.test.mjs`.** Not required by (ii) but required for everything else that
uses it (`MeshRelayHost` over a real wsh host, (i-a)). Make the backend honour `gateway-credit` (return credit as the user
side consumes; send only while it holds credit), or build on the wsh client's gateway channel; add UDP receive or document
send-only. Tests: against the real in-memory host, 4 MiB each way with a slow reader (the scratch script of 1.1 becomes the
test), a reader that stops, a close from each end; an older peer without the feature keeps today's behaviour; each rule broken
once. Mock and real-host suites stay.

**Stage 1: the core, TCP and DNS (new package, minor).** Protocol `egress` v1: `connect`, `resolve`, streams; grants and the
wildcard probe; sets; the `dial` seam with the wsh in-process dialer in `./node`; limits, audit, meter, revocation, no chain,
indicator or unattended; consumer `connectEgress`, `link.connect` returning a netway `StreamSocket`, `link.resolve`,
`link.asBackend()`. Tests: unit for every rule and every refusal reason (each broken once); a hostile consumer (bad frames,
streams for unknown cids, a flood) and a hostile provider (wrong pod, bad answers); the address policy against a table and
against a resolver double that answers differently the second time (rebinding); a provider-side test that bytes at the
origin equal bytes written; **a real two-peer run**: two Node peers over real WebRTC (`node-datachannel`, the ingress
real-peer pattern, `REQUIRE_REAL_PEER` in CI) with a real local TCP origin, 4 MiB each way, a revoke mid-transfer, and a
refusal of loopback.

**Stage 2: browser run, CLI, and the consumer adapter (usable by the first consumer).** The `browsermesh-egress` CLI
(identity file mode 0600, prints the pod id to grant, `--allow`, `--set`, refuses a wide mode without its acknowledgement);
`tests/browser/egress.spec.mjs` in Chromium, Firefox and WebKit as `ingress.spec.mjs` does: a page as consumer, a Node
provider, real WebRTC, strict CSP, a granted connect works, an ungranted one is refused, a revoke ends it; an example in
`examples/` showing the adapter from `link` to a callback-style TCP backend with pause and resume (generic, naming no
consumer); docs: README, a `docs/security.md` section with this threat table, this page updated from design to built.
**After stage 2 the first consumer can use it**, for the destinations the operator grants.

**Stage 3: the fetch form.** `link.fetch` and the provider's fetch handler: checked dial per hop, granted redirects, header
and response policy, streamed body, GET and HEAD, then `POST` only on request; hostile-destination tests (a redirect to a
private address, a slow body, an oversize body, `Set-Cookie`, a response that lies about length); real two-peer and Chromium.

**Stage 4: UDP, only if the owner wants it.** One destination per flow, replies read, wsh's bounds, datagram semantics
stated (a payload may be dropped); needs a real-host UDP test, which no layer has today. The first consumer does not need it.

**Stage 5 (on demand): a Wisp front end** over the stage 1 core, if an unmodified Wisp client must be served. Needs the Wisp
specification read first.

### 6.3 Which stage gives the first consumer something to use

Stage 2, with stage 1. Stage 0 is not on its path. It is useful *before* the consumer relies on the mesh only if the owner
wants the existing `MeshRelayHost` path fixed.

### 6.4 Decisions that are the owner's

1. **The package name.** `@johnhenry/browsermesh-egress` mirrors ingress and is what the issue says; an alternative is
   `-gateway` (collides in meaning with wsh's gateway).
2. **Whether a wildcard destination mode exists at all.** Without it the first consumer gets only curated sets (registry and
   package hosts); with it, a provider can be an open proxy for its grantees. My default: no wildcard in v1; sets only; if
   later, the acknowledgement of 4.2, never on by default, never overriding 4.3.
3. **Default budgets** (4.6). My proposals are marked; the first three rows (connections, rates, per-consumer bytes) decide
   how a provider is used.
4. **Whether UDP is in the first version.** My default: no. The first consumer has no UDP, wsh over WebSocket carries
   UDP on the reliable stream, and no layer has a real-host UDP test.
5. **Whether the fetch form is in the first version.** My default: no, stage 3, because it changes what the provider sees.
6. **Reversing the "gateway rights never from mesh trust" rule**, narrowly, for `egress:*` scopes, in
   `docs/capability-notation.md` and `docs/wsh-and-browsermesh.md:107`. (ii) does not translate to wsh capabilities and so
   needs only a sentence saying egress is a new mesh scope; (i-b) would need it reversed.
7. **The provider's dial: (A) wsh in-process, or (B) its own guard**, and whether to ask wsh to export its address guard.
8. **Direct links only in v1** (as ingress) or routed delivery with sealing.
9. ~~Whether to file the `GatewayBackend` flow-control finding as an issue and treat stage 0 as its own change.~~ Done: it
   is #381.

## 7. What I could not determine by reading

- **Whether bulk transfer through a mesh data channel is fast enough** for an image pull, and how it behaves across NATs,
  with TURN, or on a relayed link. No benchmark of the protocol channel's throughput is in the repository.
- **The Wisp protocol details** (packet layout, version 2 extensions, flow-control semantics) and whether the consumer's Wisp
  client accepts a custom socket class. I did not read the specification or the client's source, and (iii) is written from
  memory.
- **What the Rust wsh-server's "WISP bridging" covers**, and whether Wisp traffic meets its gateway policy.
- **Whether a composition of `WshRelay` to a machine wsh host with a gateway and `GatewayBackend` works end to end** (1.3),
  beyond the 256 KiB limit shown (since fixed); nobody has run it.
- **UDP through a real wsh host from netway**: since the #381 fix one datagram sent through a real host is received by a
  real UDP socket; replies are not read (send-only); wsh tests its own UDP, I did not run those.
- **Whether `client.openTcp` exposes the address the host dialled**, which the audit would like; the README does not say.
- **Whether Node's HTTP client can be made to connect to exactly a checked address with TLS and a host name intact** for
  the fetch form: believed so through `lookup`, not tried.
- **Behaviour of the Rust `wsh-server` gateway against the same bulk test**: not run (no Rust host here); the README says
  the same credit rules apply.
- **Any browser behaviour of the gateway path or of a page as a consumer**: nothing in `tests/browser/` covers it.
- **Whether a registry `matchScope` probe with a literal `*` host catches every wildcard grant a consumer could hold**,
  for example through ACL templates rather than `grantCapabilities`; the tokens path is described in
  `peer-registry.mjs:459-474`, and a test must try the templates path.
- **The consumer's real concurrency profile** beyond its own limits (how many parallel connections an image pull plus a
  package install opens); the proposed 16 per consumer comes from its overlay limit, not a measurement.
- **Legal and operational exposure of providers** in any jurisdiction: 4.10 lists what the code can show; it is not advice.
