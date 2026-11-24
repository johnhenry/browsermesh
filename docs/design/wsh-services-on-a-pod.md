# wsh services on a pod

Item 6 of [#334](https://github.com/johnhenry/browsermesh/issues/334), per the
owner's decision of 2026-11-24: a stock wsh client (`wsh`, `wsh-mcp`, `WshClient`)
may use a pod's **objects** and **MCP tools**. Off by default; objects and MCP
only (never exec, pty, files, the gateway, or any endpoint); opt-in per pod;
permitted only by the pod's registry grants for the connecting key's pod id.
Code: `packages/browsermesh-transport/src/wsh-services.mjs`.

There is no open question for the owner here: every choice below is the
conservative one, and each says what the other choice would cost, so it can be
changed without redoing the rest.

## Decisions

**1. A separate host, separately enabled, not extra channels on the mesh host.**
Today a pod's wsh link host (`WshPeerLinks.listen()`) is a memory host with
`sealSession: 'require'`, one endpoint `mesh`, and every key it admits limited to
`endpoint:mesh`. Adding `wsh-objects` and `mcp` rpc channels beside `mesh` on that
host would be one switch fewer, but:

- the mesh host admits every pod the registry lets link (`mesh:link:connect`), and
  its login rule requires the user name to be `pod_<pod id>`. A stock wsh client
  logs in under any user name. Two different admission rules on one host is a
  host that has to be read very carefully;
- turning the services on would change what a mesh peer's session can reach (the
  same session, more channels), instead of leaving that host exactly as it is;
- "off by default, opt-in per pod" is simplest to state, to test and to audit as
  a thing that is not constructed unless asked for.

So the services are a second host (`WshServices`) that is **not constructed by
anything in the repository** unless the embedder asks for it, listens at its **own
rendezvous id**, and shares nothing with `WshPeerLinks` but the pod's key. The cost: two waiting host
halves per pod instead of one (the same relay), and a second address for a stock
client to dial. The other choice (extra channels on the mesh host) stays possible
later; the authorisation below does not depend on it.

**2. The rendezvous id is its own.**
`rid = base64url(SHA-256("browsermesh-wsh-services/1:" + podId))` (43 characters),
derived from a public value like the mesh link's (`browsermesh-wsh-link/1:`), so the
two cannot be mistaken for each other. It is not a secret and nothing relies on
it being one: what stops an impostor is that the client pins the host key and the
host authenticates the client. A stock client dials `<relay>/r/<rid>` with the
host key fingerprint of the pod (`podIdToFingerprint(podId)`) as its pin.

**3. Sealed sessions only; the pod's key is the host key; pinned by pod id.**
`sealSession: 'require'`, `requireChannelBinding: true`, `hostKey` = the pod key
(so the pin a client uses is the pod id it already knows), exactly as the mesh
host does. A plain client, or one that does not bind its login, is refused
(`onRefused`). The pod key already signs a wsh host proof in the mesh link; this
adds no new use of it.

**4. Who the caller is: the hash of the key wsh authenticated.**
`podId = base64url(SHA-256(raw key))`, derived from `who.fingerprint` after the key's
signature verified. The user name is a label (it is shown, never trusted, and any
name is accepted); nothing in a key line (`authorized_keys` options, a
`capabilities="..."` string, `expires`) is consulted, and the host is given no
`authorizedKeys` at all.

**5. Permission is the registry's, per channel, per request.**
The same grant strings as the mesh uses (`docs/design/mcp-over-mesh.md`), checked
through the pod's `PeerRegistry` for that pod id:

| step | scope | if missing |
|---|---|---|
| log in at all | `wsh-services:open` | refused before any channel (`unknown key`) |
| open the MCP channel | `protocol:mcp:open` | the channel is refused |
| list / call a tool | `mcp:<tool>:list` / `mcp:<tool>:call` | not listed / "unknown tool" |
| open the objects channel | `protocol:objects:open` | the channel is refused |
| an object operation | `objects:<root>:<action>`, action `get` (get, describe, snapshot), `call` (call, construct), `set`, `on` | refused |

`objects:*:get` and `mcp:*:call` are the registry's own wildcards. The per-root and
per-tool decisions are asked on **every** request, so a revocation or an expiry
applies to the next one; the login and channel grants are asked again whenever the
registry says that pod's access changed (revocation, removal, update, expiry), and a
session whose pod no longer holds `wsh-services:open` is **closed** (the client is
told why first). The host's own allow-lists are the page's: `mcp.allow` (exact tool
names) and `objects.roots` / `objects.allow` (wsh's per-operation path lists) say what
exists at all; a grant never widens them. What a mesh peer is granted and what a wsh
key is granted are the same strings for the same pod id: granting a key is
`registry.grantCapabilities(podId, [...])`, and a key that is also a mesh peer has one
set of grants for both.

**6. Objects and MCP only, structurally.** The host is a memory host given
nothing but two rpc handlers. It has no `exec`, `pty`, `fs`, `targets`, `endpoints`,
`relay` or `onShare`, so none of those exist on it (not "are refused by policy":
are not there), and a key's wsh capabilities are set at login to exactly
`rpc:mcp` and/or `rpc:wsh-objects`, from the registry, only for the channels it holds a
grant for. Tests assert each of exec, a pty, a file operation, a TCP, UDP or unix
gateway connection, the mesh endpoint and the other wsh rpc protocols (`wsh-host`,
`wsh-fs`) is refused.

**7. Approval stays with the page.** The MCP tools are served by wsh's WebMCP
bridge, with the page's `approve` mode (default consequential) and its `prompt`.
The question is the serving page's; the wsh client cannot answer it.

**8. Bounds.** `maxSessions` (default 4: more are refused at login),
`connectionTtlMs`, the host's `rpcMaxInflight` and `rpcMaxMessageBytes`, the tool
bridge's limits (`mcp.limits`) and the object server's (`objects.limits`); a login that
does not finish in `bindTimeoutMs` is dropped.

**9. One audit event per session, and per refusal.** `onAudit({ event, podId, ... })`
with `event` one of `session-open`, `session-close` (with the reason: `closed`,
`revoked`, `stopped`, `ttl`), `refused` (with wsh's reason, or `no-grant`),
`channel-refused` (which channel) and `revoked`. Every event names the pod id (never
the user name alone). A session begins when wsh says it is **sealed** (`onSealed`,
wsh 0.49), not at login: on this host a login is told `sealRequired`, so a plain
client that passes login is served nothing and is neither listed, audited as a
session nor shown to the indicator (its refusal is audited as `refused`). A login
that is waiting to be sealed counts toward `maxSessions`.

**10. An indicator when the pod runs in a page.** `start()` refuses to start unless
the embedder passes an `indicator` (`{ connected(who, control), disconnected(who) }`, the
same shape as wsh's page host, so the same badge code serves both; `control.stop()`
ends that session and refuses that key until the services are restarted) or says
`unattended: true`. wsh 0.49 exports its badge as `createPageIndicator(window, { name })`
(`show(who, stop)`, `hide(who)`); a page passes
`{ connected: (who, c) => badge.show(who, c.stop), disconnected: (who) => badge.hide(who) }`.
The services themselves still do not fabricate DOM, so this removes no code here.

## What a stock client does

```
wsh-mcp wss://relay.example/r/<rid>   (pin: the pod's fingerprint; key: a key whose pod id the pod granted)
```
logs in with its key, is sealed, and sees `rpc:mcp` / `rpc:wsh-objects` if it holds
the matching grants. `new WshClient().connect(url, { keyPair, expectHostKey, sealSession: true })`
then `client.openRpc('mcp')` or `client.openObjects()` is the same thing in JavaScript.
Whether the released CLI can dial a pipe relay URL is wsh's matter; the tests here use the
JavaScript client over the in-process pipe relay and do not run the CLI.

## Not protected

- A key that holds grants can do what they say. The hash of a key is not a person.
- A tool does what its `execute` does with the page user's session; an object operation
  does what the allowed path does. The allow-lists and the prompt narrow who can start it.
- The relay sees who dials which rendezvous id and when, and the size and timing of each
  record (as for the mesh link).
- The pod's key now answers wsh logins at a second rendezvous id. An impostor can occupy
  a waiting slot (the slots are topped up); it cannot become the pod.
- A revoked key can dial again, and is refused again at login.

## Wire and older peers

Nothing changes for the mesh: `WshPeerLinks` and every mesh message are untouched. The
only new wire facts are the rendezvous label and the scope strings above. A pod without
this code simply has nothing waiting at that rendezvous id: a client dialling it gets no
host and times out. Off, a pod behaves exactly as before.
