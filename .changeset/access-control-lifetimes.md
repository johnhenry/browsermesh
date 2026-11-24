---
'@johnhenry/browsermesh-apps': minor
'@johnhenry/browsermesh-primitives': patch
---

Access control: one scope matcher, grants that end are announced, and what holds a grant open follows it.

- `matchScope()` (primitives) compares scopes segment by segment for any number of segments; it used to ignore every segment past the third. Scopes of three segments or fewer match exactly as before. `PeerRegistry`'s built-in ACL (used when none is injected) now uses it instead of a matcher that looked at two segments, so `mesh-relay:<service>:connect`, `server-share:<name>:request`, `protocol:<name>:open`, `mesh:link:connect` and the like match their grants (before, only `*:*` did) and `mesh-relay:*:connect` no longer matches every action.
- A grant with `expiresAt` is announced like a revocation: `registry.onAccessChange` gets `{ pubKey, kind: 'expired' }`, from one timer per registry for the nearest expiry. New options `clock` and method `dispose()`.
- Long-lived holders follow access changes instead of waiting for their next use: `createMeshWebSocketService` sessions (new `accessResource`, `accessAction`, `recheckOnAccessChange`; closed with 4403 `access revoked`), open protocol channels, swarm members admitted through the join gate, wsh links under the default authorizer (new `watchWshAccess()`), and torrent serving after a rate-limit wait.
- `createProxyHandler()` checks the caller (`checkAccess`, `resource`, `public`).

Breaking defaults: `createProxyHandler()` answers 403 to every request unless given `checkAccess` or `public: true`; `createMeshWebSocketService` now asks `onConnection` again when that peer's access changes (set `recheckOnAccessChange: false` to keep the old behaviour); a protocol channel is closed at the moment of revocation rather than on its next use. A registry with no injected ACL that relied on three-segment scopes matching only `*:*` now matches the scopes it was granted. No wire change: pods on older versions are unaffected.
