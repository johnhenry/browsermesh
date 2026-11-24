---
'@johnhenry/browsermesh-apps': patch
---

`PeerRegistry.grantCapabilities` refuses a malformed `objects:` or `mcp:` scope, and `isGrantableScope(scope)` is exported (#334).

These two namespaces have a written grammar in wsh's capability notation (`objects:ROOT[:OP]`, `mcp:TOOL`), and wsh refuses a list that holds an entry it does not understand. The registry used to take any string, and because `matchScope` reads a missing or empty segment as `*`, a grant of `objects:` covered every root and `mcp:` every tool. Now `objects:` and `mcp:` entries must name a root or a tool, `objects:` takes at most an operation (`get`, `call`, `set`, `on`, or the registry's own `*`), `mcp:` at most `call` or `list`, and a call with an entry that does not follow this throws a `TypeError` and grants nothing (the whole call, not the entries before it). Scopes in every other namespace are unchanged, including `objects:ROOT:*`, `objects:*:get`, `mcp:*` and `protocol:*:open`. A `GrantLog` replay skips a scope the registry would refuse instead of stopping.

A caller that granted a malformed `objects:` or `mcp:` entry (which covered more than it said, or nothing) now gets a `TypeError` where it used to get a silent grant. `docs/capability-notation.md` lists where wsh's notation and the registry differ and which side was changed.
