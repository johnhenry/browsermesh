# What is protected today

This page states, per area, which properties hold between peers in the code
as released, and which do not. It is kept short and is updated by the change
that alters a property. Each statement names the package that provides it.
(Tracking issue for implementation status: #269.) Other areas have their own
pages next to this one (`what-is-protected-*.md`), added by the changes that
establish them.

"Peer key" below means the key of the session a message arrived on, as
reported by the transport to `PeerNode.onIncomingData()`. It is never a field
of the message itself.

## Shared HTTP servers (`@johnhenry/browsermesh-apps`: `ServerSharing`, `createProxyHandler`)

Protected:

- A request from a peer is served only if
  `PeerRegistry.checkAccess(peerKey, 'server-share:<name>', 'request')`
  allows it. Default: refused.
- The upstream URL is built from the configured origin and a path the peer
  supplies. A path that is not a plain absolute path (scheme, authority,
  backslash, control character, fragment, `//` prefix) is refused, and the
  resolved URL's origin must equal the configured origin.
- Redirects from the upstream are not followed. Request methods, request
  headers, request size, response size and request time are bounded; `Host`,
  `Cookie`, `Authorization` and hop-by-hop headers are never taken from a
  peer.

Not protected:

- Confidentiality of the proxied request and response against peers that
  forward it. Messages that pass through other peers are readable by them.
- Who may call `createProxyHandler()` when it is mounted on a site: that
  check belongs to whatever serves the site.
