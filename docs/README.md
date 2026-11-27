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
- [`design/egress.md`](design/egress.md): research and design for an egress package, the mirror of ingress (a pod that lends
  its network access to peers under per-destination grants): what exists today, the options, the safety requirements, a
  staged plan. The core (TCP and name lookup) is built as `@johnhenry/browsermesh-egress`; the page says which decisions
  replaced the note.
- [`design/link-admission.md`](design/link-admission.md): a restricted state for links whose peer is not yet known (the cap, the
  deadline, one handler, promote or close), over wsh and WebRTC, with the gaps it leaves.
- [`design/routed-confidentiality.md`](design/routed-confidentiality.md): sealing of messages routed through other peers.
- [`design/stealth-threshold.md`](design/stealth-threshold.md): threshold key sharing for StealthAgent (built in `browsermesh-discovery`, opt-in).
- [`design/discovery-records.md`](design/discovery-records.md): shard checksums, shard parity, who may store, and on-demand
  release of key shares in `browsermesh-discovery`; all built, all off by default.
- [`design/mcp-over-mesh.md`](design/mcp-over-mesh.md): a page's WebMCP tools reachable from another browser over a protocol
  channel (`@johnhenry/browsermesh-mcp`).
- [`design/wsh-over-mesh.md`](design/wsh-over-mesh.md): a pod serving or dialling a wsh session over a mesh channel instead of
  a relay, and a pod relaying a wsh session for a peer under a per-target grant.
- [`design/wsh-services-on-a-pod.md`](design/wsh-services-on-a-pod.md): letting a stock wsh client use a pod's objects and MCP
  tools, off by default and permitted only by the pod's registry grants.
- [`design/realms.md`](design/realms.md): a proposed portable "this is the mesh, and this is who may be in it" object
  (signed realm descriptors, roles, credentials); read the page for what is built.
- [`hosted-pods.md`](hosted-pods.md), [`design/hosted-pods-firecracker.md`](design/hosted-pods-firecracker.md),
  [`design/hosted-pods-security-review.md`](design/hosted-pods-security-review.md): running a `Pod` outside the browser.
- [`design/hosted-pods-open-decisions.md`](design/hosted-pods-open-decisions.md): the hosted-pods decisions that are the owner's,
  each with its state, options and recommendation.
- [`runbook-firecracker-kvm.md`](runbook-firecracker-kvm.md): the one checklist left for the microVM lane, for a Linux/KVM
  host: exact commands, expected output, what to report.
- Per package: each `packages/*/README.md`; for building services, `packages/browsermesh-apps/docs/`.
