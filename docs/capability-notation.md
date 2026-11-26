# Capability notation: wsh keys and mesh scopes

Two systems say what a holder may do, in strings that look alike.

- **wsh** (a key's `capabilities="..."` in `authorized_keys`, or what an `authorize()` returns): a default-deny list
  such as `objects:window:get,mcp:search,exec`. Its grammar, evaluation order and test vectors are wsh's
  (`spec/capabilities.md` and `spec/capabilities.vectors.json`, shipped in the `@johnhenry/wsh` package since 0.49.0 and
  importable as `@johnhenry/wsh/spec/capabilities.vectors.json`; the notation as a pure function is
  `@johnhenry/wsh/capabilities`: `permits`, `checkCapabilities`, `parseCapabilityList`). Nothing of that is mirrored here
  any more: the strings and the table below say how the registry relates to it, and the vectors are run, not copied.
- **browsermesh** (`PeerRegistry.grantCapabilities` / `checkAccess`, `MeshACL`, `matchScope`): scopes
  `<namespace>:<resource>:<action>` compared segment by segment, a missing or empty segment counting as `*`.

They coincide on a few forms. This page says which, how one is written as the other, and where they differ. The
registry is run against wsh's vectors for the shared forms by
`packages/browsermesh-apps/test/capability-vectors.test.mjs`; each disagreement found is listed there with a verdict.

## One table

| wsh capability | mesh scope | A mesh check | Notes |
| --- | --- | --- | --- |
| `objects:ROOT` | `objects:ROOT` | `checkAccess(peer, 'objects:ROOT', op)` | every operation on ROOT: a shorter scope covers what is beneath it |
| `objects:ROOT:get` / `call` / `set` / `on` | the same string | `checkAccess(peer, 'objects:ROOT', 'get')` etc. | `describe` and `snapshot` are `get`; `construct` and a call that carries callbacks are `call`; a subscription is `on` (`browsermesh-objects` `actionFor`) |
| `objects:*`, `objects:*:get` | the same string | | `*` is every root, in both |
| `objects:ROOT:*` | `objects:ROOT:*` | | **mesh only**: wsh refuses it (`bad-capability`); write `objects:ROOT` for a wsh key |
| `mcp:TOOL` | `mcp:TOOL` (spelled `mcp:TOOL:call` and `mcp:TOOL:list` by `@johnhenry/browsermesh-mcp`, plus `protocol:mcp:open`) | `checkAccess(peer, 'mcp:TOOL', 'call')` (`'list'` to see the tool) | `mcp:*` is every tool, in both. `WshServices` (transport) admits a wsh client to objects and MCP by these same registry scopes, not by key options |
| `objects:ROOT[:OP]` over a wsh client | the same strings | as above | `WshServices` and `@johnhenry/browsermesh-objects` use the same scopes; `wshObjectActionFor` (transport) and `actionFor` (objects) are kept equal by a parity test |
| `rpc:NAME` | `protocol:NAME:open` | `checkAccess(peer, 'protocol:NAME', 'open')` | opening a protocol channel. `rpc:` is not a mesh namespace |
| `rpc:*` | none | | wsh has no wildcard for rpc. Do not translate the mesh's `protocol:*:open` into it |
| `expires="2030-01-01T00:00:00Z"` | `grantCapabilities(peer, scopes, { expiresAt })` (ms) | | both refuse at the instant (`now >= expires`); a grant that expires is announced like a revocation (`onAccessChange`) |
| `exec`, `pty`, `fs:*`, `gateway:*`, `unix:*`, `endpoint:*`, `target:*`, `relay`, `rpc:wsh-*` | none | | machine rights. **Never granted from mesh trust**, and not translated either way. The one outbound-network grant the registry makes is the `egress:*` family below, which is its own scope family and not a translation of `gateway:*` |
| none (a wsh gateway has `gateway:tcp:HOST:PORT`, which nothing here reads or writes) | `egress:tcp:HOST:PORT:connect`, `egress:tcp:HOST:*:connect`, `egress:dns:NAME:resolve`, `egress:set:NAME:connect`, and the fetch and UDP forms (`egress:http:HOST:PORT:fetch`, `egress:udp:HOST:PORT:send`, `egress:set:NAME:fetch`, `egress:set:NAME:send`) | `checkAccess(peer, 'egress:tcp:HOST:PORT', 'connect')` etc. | **mesh only**: `@johnhenry/browsermesh-egress`, see [Egress scopes](#egress-scopes) |

Reading the table: a mesh scope in the left-hand column's namespaces can be copied into a wsh key line as it stands
when it appears under the same spelling, and the `rpc:` row is a rename. Nothing is converted automatically in either
direction.

## Egress scopes

The rule above, that the machine rights are never granted from mesh trust, is about **trust**: being reachable on the mesh,
being a known pod, or holding a trust score never gives `exec`, files, a wsh gateway or hosted pods, and no code derives
one from the other. It is not a rule that no registry grant may ever name outbound network access. The egress package
(`@johnhenry/browsermesh-egress`) is the one place a registry grant does, by design and only because an operator wrote it:
a pod that lends its network to a peer checks the grants of its own registry, and nothing else, before it opens a
connection for that peer. It does not translate to or from a wsh `gateway:` capability, does not run a wsh gateway for
the peer, and gives the peer none of the other machine rights. Its scopes, each granted by the operator with
`grantCapabilities` (and so revocable, and expirable with `expiresAt`):

| Scope (the string granted) | Meaning |
| --- | --- |
| `protocol:egress:open` | may open the protocol channel at all (default deny, as for every protocol) |
| `egress:tcp:<host>:<port>:connect` | open TCP to exactly that host and port. `<host>` is a lowercase DNS name or a canonical IPv4 dotted quad (no `:`, no `*`); a grant for a name does not cover that name's address, and the reverse |
| `egress:tcp:<host>:*:connect` | any port of exactly that host (the provider's blocked ports, 25, 465 and 587 by default, still apply) |
| `egress:dns:<name>:resolve` | look up exactly that name. Connecting by name does not need it; a lookup is its own grant |
| `egress:set:<name>:connect` | connect to anything the operator's set of that name lists (exact hosts, `*.suffix`, IPv4 blocks, port lists; the sets are written on the provider and never by a peer) |
| `egress:http:<host>:<port>:fetch`, `egress:http:<host>:*:fetch`, `egress:set:<name>:fetch` | the **fetch form**: the provider makes an `http(s)` request to that origin and returns the response. **The provider sees the request and the response in plaintext**: this grant is trust in the provider with them, which is why a TCP grant for the same destination is not one |
| `egress:udp:<host>:<port>:send`, `egress:udp:<host>:*:send`, `egress:set:<name>:send` | UDP datagrams to exactly that host and port (the provider's blocked UDP ports, 53 by default, still apply: DNS is `egress:dns`) and what that address answers |

The registry compares scopes segment by segment and a `*` is a whole segment, so a host is one segment, and a block or a
suffix cannot be written in a grant: those live in the operator's sets. A grant with a literal `*` where a host goes
(`egress:tcp:*:443:connect`, `egress:tcp:*:*:connect`, `egress:http:*:*:fetch`, `egress:udp:*:*:send`, `egress:dns:*:resolve`, `egress:*`, `egress:tcp:*`, `*`) is a
**wildcard grant**: the provider asks the registry about those literal forms for each request, finds them, and refuses
with `wide-not-acknowledged` unless its operator acknowledged wide mode (`wide: { acknowledge: 'any-public-address' }`),
even when an exact grant would also cover the request. With the acknowledgement a wildcard grant reaches any **public**
destination and never private, loopback, link-local, unique-local, carrier-NAT or metadata space: only the operator's own
`allowPrivate`, for destinations a grant names, admits private space, and a peer's grant never does.

## Where the two differ

Each was found by running wsh's vectors against the registry. "Right" is by the written grammar.

1. **A malformed entry.** wsh refuses a list that holds an entry it does not understand (`objects:`, `objects:window:fly`,
   `objects:window:get:x`, `mcp:`) and keeps none of the rest. The registry used to take them, and because an empty
   segment reads as `*`, `objects:` covered every root and `mcp:` every tool. wsh is right. **Changed**:
   `PeerRegistry.grantCapabilities` refuses such an entry in the `objects:` and `mcp:` namespaces, the whole call
   (nothing is granted in part); other namespaces are the registry's own and are not checked. `GrantLog` replays skip a
   scope the registry would refuse instead of stopping.
2. **`walk`.** wsh lets any `objects:ROOT[:OP]` entry read the properties on the way to something else (`walk`). The
   registry has no such action. Not changed: the object layer asks the registry about the terminal operation only, and
   a peer is told of a root if it holds any action on it.
3. **`rpc:*`.** wsh has none; the registry's `protocol:*:open` is its own documented wildcard. Not changed (see the table).
4. **Root names.** wsh: `*` or letters, digits, `_`, `$`, `-`, starting with a letter, `_` or `$`, up to 64 characters.
   `createRootAuthorizer`: letters and digits, `.`, `_`, `-`, up to 128, starting with a letter or digit (no `$`, no
   leading `_`). A root reached through both must be in the intersection. Not changed.
5. **Tool names.** wsh allows `:` inside a tool name (`mcp:ns:tool`); a mesh scope cannot (the segment ends there).
   A tool name with a colon has no mesh scope. Not changed.
6. **`objects:ROOT:*`.** The registry's wildcard for an action; not in wsh's grammar (see the table). Not changed.
7. **A list that has no `objects:` entry.** In wsh, `rpc:wsh-objects` alone means every root and operation, and any
   `objects:` entry opens the channel. In the mesh, opening the protocol (`protocol:objects:open`) and a grant per root
   and action are separate and both are needed. Not changed: this is the stricter of the two and deliberate.

Everything else the vectors say about the shared forms (exact names, case sensitivity, `*` as every root or tool,
that `get` is not `call` is not `set` is not `on`, an empty list permitting nothing, expiry at the instant) agrees.

## Running the vectors

```
npm test                                       # runs it from the installed @johnhenry/wsh (0.49.0 or later)
WSH_CAPABILITY_VECTORS=/path/capabilities.vectors.json npm test --workspace=@johnhenry/browsermesh-apps
```

The apps package's `npm test` sets `REQUIRE_WSH_VECTORS=1`, so a wsh that does not ship the vectors is a failure, not a
skip (CI runs it). Against wsh 0.49.0's vectors (notation version 1, 145 requests and 32 lists, of which the shared forms
for the Node host class are run) the registry agrees on every vector except the three listed in the test, all described
above: **`objects: that operation allows walking toward something`** (item 2), **`rpc: has no wildcard form`** (item 3) and
**`objects: a path is not a root`** (item 4). No new disagreement appeared with the shipped vectors. Listing and running a
tool are mapped apart (`mcp:TOOL:list`, `mcp:TOOL:call`), as wsh 0.49's `mcp-tool` and `mcp-call` requests are.

A known disagreement is listed in the test with the reason; the test fails if a listed one starts to agree (the entry
is stale) and if an unlisted one appears.
