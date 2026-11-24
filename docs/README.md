# Documentation index

- [`security.md`](security.md): what each package protects and does not, written from the source; the status of every
  package; how each claim is verified.
- [`wsh-and-browsermesh.md`](wsh-and-browsermesh.md): wsh and browsermesh together: where they meet, how a capability and a
  key are written in both, how to run objects across the mesh, what is not shared, and what is not verified.
- [`capability-notation.md`](capability-notation.md): wsh key capabilities and mesh scopes, side by side, and where they
  differ.
- [`protocol-channel.md`](protocol-channel.md): the seam for layered protocols over a mesh channel, how a protocol is
  opened and authorised, and how the remote-object layer is mounted on it.
- [`design/wsh-peer-link.md`](design/wsh-peer-link.md) and [`migration-wsh-peer-link.md`](migration-wsh-peer-link.md): a mesh
  link carried on a sealed wsh session, and how to adopt it.
- [`design/http-ingress.md`](design/http-ingress.md): real HTTP in, a mesh pod answers (`@johnhenry/browsermesh-ingress`):
  the API, the wire (protocol `http` v1), pinning, the defaults, and what is not built.
- [`design/routed-confidentiality.md`](design/routed-confidentiality.md): sealing of messages routed through other peers.
- [`design/stealth-threshold.md`](design/stealth-threshold.md): threshold key sharing for StealthAgent (spec only).
- [`hosted-pods.md`](hosted-pods.md), [`design/hosted-pods-firecracker.md`](design/hosted-pods-firecracker.md),
  [`design/hosted-pods-security-review.md`](design/hosted-pods-security-review.md): running a `Pod` outside the browser.
- Per package: each `packages/*/README.md`; for building services, `packages/browsermesh-apps/docs/`.
