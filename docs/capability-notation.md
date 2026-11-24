# Capability notation: wsh keys and mesh scopes

Two systems say what a holder may do, in strings that look alike.

- **wsh** (a key's `capabilities="..."` in `authorized_keys`, or what an `authorize()` returns): a default-deny list
  such as `objects:window:get,mcp:search,exec`. Its grammar, evaluation order and test vectors are wsh's
  (`spec/capabilities.md` and `spec/capabilities.vectors.json` in the `@johnhenry/wsh` repository; the vectors ship
  in the package from the release that introduced them).
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
| `mcp:TOOL` | `mcp:TOOL` (also written `mcp:TOOL:call`) | `checkAccess(peer, 'mcp:TOOL', 'call')` | `mcp:*` is every tool, in both |
| `rpc:NAME` | `protocol:NAME:open` | `checkAccess(peer, 'protocol:NAME', 'open')` | opening a protocol channel. `rpc:` is not a mesh namespace |
| `rpc:*` | none | | wsh has no wildcard for rpc. Do not translate the mesh's `protocol:*:open` into it |
| `expires="2030-01-01T00:00:00Z"` | `grantCapabilities(peer, scopes, { expiresAt })` (ms) | | both refuse at the instant (`now >= expires`); a grant that expires is announced like a revocation (`onAccessChange`) |
| `exec`, `pty`, `fs:*`, `gateway:*`, `unix:*`, `endpoint:*`, `target:*`, `relay`, `rpc:wsh-*` | none | | machine rights. **Never granted from mesh trust**, and not translated either way |

Reading the table: a mesh scope in the left-hand column's namespaces can be copied into a wsh key line as it stands
when it appears under the same spelling, and the `rpc:` row is a rename. Nothing is converted automatically in either
direction.

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
npm test                                       # runs it when the installed @johnhenry/wsh ships the vectors
REQUIRE_WSH_VECTORS=1 npm test                 # fail instead of skipping when they are missing
WSH_CAPABILITY_VECTORS=/path/capabilities.vectors.json npm test --workspace=@johnhenry/browsermesh-apps
```

A known disagreement is listed in the test with the reason; the test fails if a listed one starts to agree (the entry
is stale) and if an unlisted one appears.
