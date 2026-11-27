# The tour

[`28-tour.mjs`](./28-tour.mjs) is one runnable script that wires the newer browsermesh packages together in a single small
app. Every other example shows one package alone; this one shows who decides what when they meet.

## The story

An app runs on **Pod A**. Real HTTP reaches it through an **ingress** pod (a `node:http` client talks to a loopback
listener). The app searches and sells things, so it also serves **MCP tools** (`search`, `buy`) and an **objects** root
(`app`) to peers. To answer some requests it must reach an upstream service, and it does not have a network of its own:
**Pod B lends it one** (**egress**), per destination, with a budget. A **stranger**, Pod C, wants in: it links over wsh, is
held **restricted**, presents a **realm** credential, is promoted, and gets only the scopes the realm's role carries that Pod
A's own policy honours. Separately, an operator drives a **pod host** with `meshctl`, a real child process, through a real
pipe relay over a sealed wsh link. Every decision is made by the pod that owns the resource, from its own `PeerRegistry`.

```
 curl ──HTTP──► ingress pod ──protocol http──►┌─────────────────────────────┐
 (node:http,    (Node, real listener)         │ Pod A, "the app"            │
  loopback)                                   │  http handler               │
 Pod C (stranger) ──wsh link, RESTRICTED────► │  objects root `app`         │
   presents a realm credential, promoted,     │  MCP tools (search, buy)    │
   cut to Pod A's realm policy                │  PeerRegistry: operator     │
   ──protocol mcp / objects───────────────►   │   grants + realm grants     │
                                              └─────────────┬───────────────┘
 Pod B ◄──protocol egress── A fetches an upstream via B     │ audit: ingress, egress,
   (egress:tcp grant, connection budget)                    │ realm events, registry
                                                            ▼
 meshctl (child process) ══sealed wsh via a real pipe relay══► pod host H ──spawn──► a hosted pod
```

All four mesh pods (A, B, ingress, C) are real `createMeshNode()` nodes linked by sealed wsh sessions over wsh's in-process
pipe relay. The pod host H and `meshctl` use a real loopback pipe relay, as in example 25. Nothing leaves this machine.

## The legs

| Leg | Packages | Allowed | Refused | Alone |
|---|---|---|---|---|
| ingress | `-ingress`, `-apps` | a GET reaches Pod A once the ingress pod holds `protocol:http:open`; the client gets the ingress's policy | before that grant: 502 `provider-not-authorized`; a method the operator did not serve: 405 | [21](./21-http-ingress.mjs) |
| egress | `-egress`, `-apps` | Pod A dials `upstream.test:<port>` through Pod B under `egress:tcp:<host>:<port>:connect` | another port of the same host: `no-grant`; a second live connection: `budget-exceeded` | [22](./22-mesh-egress.mjs) |
| realm | `-realm` (0.1.x preview), `-apps` (`createMeshNode({ realm })`, `node.realm.present`), `-transport` | a stranger whose credential names its own key is promoted and holds the role's scopes | no credential: `no-credential`; another key's credential: `subject-mismatch`; the role's scopes Pod A's policy omits are dropped | [26](./26-realm-admission.mjs) (lower-level pieces) |
| mcp | `-mcp`, `-apps` | the stranger lists and calls `search` (the result is labelled untrusted) | `buy`: its scopes were dropped, so it answers like a tool that does not exist | [23](./23-mcp-tools-over-mesh.mjs) |
| objects | `-objects`, `-apps`, wsh | the stranger reads `app.title` | `app.secret` (not on the allow-list); `set` (its scope was dropped) | [19](./19-wsh-objects-over-protocol-channel.mjs) |
| meshctl | `-meshctl`, `-transport`, `-pod`, wsh | `meshctl pods spawn` through the relay, as an identity the host allowed | `meshctl host describe` as an identity it did not: `WSH_REFUSED`, exit 3 | [25](./25-meshctl-through-a-relay.mjs), and [24](./24-wsh-services-and-relaying-pod.mjs) for a relaying pod |

The script ends with what was recorded: ingress (status of every request, no query strings), egress (connections opened,
refused, closed, bytes), the registry on Pod A (realm grants held, scopes dropped by policy, the realm events) and a count of
ALLOWED and REFUSED lines.

## Run it

```bash
npm ci
node examples/28-tour.mjs        # about 10 s; exit 0
npm run examples                 # runs it with the others (60 s limit each)
```

Node >= 26. Listeners are on `127.0.0.1`, port 0, and are closed before exit.

## What the tour does not show

- **Tickets** (introduction by a third party), several realms on one node, credential renewal and `autoRenew`.
- **`meshctl --signaling`** (WebRTC): the tour uses `--wsh-relay` only. VMM-backed hosts: H is the in-memory driver.
- **Discovery**: pods are linked by pod id; no DHT, no stealth records (see [27](./27-dht-and-stealth-records.mjs)).
- **A browser**: everything is Node; see [`tests/browser/README.md`](../tests/browser/README.md) for what runs in one.
- **The realm package is a preview**: `@johnhenry/browsermesh-realm` is published on npm as 0.1.x, but its API may change
  before 1.0; the tour runs the workspace copy from this repository. `createMeshNode({ realm })` itself is in `-apps` (>= 0.30).

## Where each claim is documented

All in [`docs/security.md`](../docs/security.md):

| Claim | Section |
|---|---|
| a link is sealed and key-authenticated; the host key is pinned to the pod id | "The wsh link" |
| a stranger is held restricted, cannot reach anything but one handler, and times out | "Link admission" |
| a credential is bound to the proven key; the host's policy caps a role; epochs revoke | "Realms" |
| the protocol seam: default deny, grants per protocol, the verified peer | "mesh-rpc, the message channel and the protocol seam" |
| a tool is listed and called only as granted; consequential tools need the serving side's person | "MCP across the mesh" |
| objects are authorised per root and per action, behind an allow-list | the `browsermesh-objects` rows of "Implementation status per package" |
| the ingress, not the pod, sets what the HTTP client gets | "HTTP ingress" |
| per-destination grants, address guard, budgets, audit without contents | "Egress" |
| what `meshctl --wsh-relay` has and has not been run against | the `browsermesh-meshctl` row of "Implementation status per package"; "Hosted pods, per lane" |
