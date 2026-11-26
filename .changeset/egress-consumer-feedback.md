---
"@johnhenry/browsermesh-egress": minor
---

What the first real consumer (a container engine in a browser tab) found, issue #379. Protocol `egress` is still version 1 and
everything is additive or negotiated: a 0.1.1 or 0.2.0 peer is answered exactly as before, and an older peer is never sent a
message it would mis-handle (the README has the table of what an older peer does for each change).

- **Response headers.** The fetch form's response allow-list adds `www-authenticate`, `link`, `docker-distribution-api-version`,
  `docker-content-digest` and the `ratelimit-*` / `x-ratelimit-*` headers (still bounded in count and size; never `set-cookie`).
  A header that carries a URL the consumer will act on is the provider's word; the consumer's request to it needs its own grant.
- **Names and addresses.** New `connectByResolvedAddress` provider option (off by default): a `connect` to an address the
  provider's OWN lookup returned for that consumer, under its `dns` grant, for `addressMemoryMs` (10 minutes) and at most
  `maxRememberedAddresses` (256) per link, is decided by the consumer's TCP grant for the name; it is dialled as it is, through
  the same address guard, with no second lookup. New `mapAddresses` consumer option (off by default) and `createAddressMemory`:
  works against any provider by asking for the name when an address is refused `no-grant`.
- **Liveness.** A `ping` request on the channel from each end (every 5 s; gone after 3 silent intervals, so about 15 s; set with
  `keepAlive: { intervalMs, misses }` or `false`), answered `{ ok: true }`. An older peer answers method-not-found, which counts as
  an answer. A dead provider ends the consumer's link `provider-gone` and everything open with that code; a dead consumer's channel
  is closed and its connections and budgets freed (`egress-consumer-gone` in the audit, `gone` in `stats()`). The link has
  `closeReason`, `whenClosed` and `onClose(cb)` with the reasons in `CLOSE_REASONS` (`closed` stays a boolean).
- **A browser entry.** `@johnhenry/browsermesh-egress/browser`: `createEgressNode({ signaling })` and `node.connect(providerPodId)`
  build the identity, the signalling connection and a lean mesh node (about 267 kB minified instead of about 1.46 MB for the apps
  package root recipe; a test bundles it and pins the size). It needs `@johnhenry/browsermesh-apps` `>=0.25.0`. The package is
  marked `sideEffects: false`.
- **Open failures.** New link codes `provider-not-found`, `provider-refused` and `signalling-unreachable` (and `provider-gone`);
  `provider-unreachable` stays the catch-all for what none of them names.
- **Docs.** README: installing for a page that only consumes (what `engines`, `node-datachannel` and `isolated-vm` bring and how to
  leave them out), a worked example of grants for pulling from public registries through the fetch form, names and addresses,
  liveness, compatibility with 0.2.0, and that UDP in a guest kernel's network backend is upstream.
