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
- [`design/stealth-threshold.md`](design/stealth-threshold.md): threshold key sharing for StealthAgent (spec only).
- [`hosted-pods.md`](hosted-pods.md), [`design/hosted-pods-firecracker.md`](design/hosted-pods-firecracker.md),
  [`design/hosted-pods-security-review.md`](design/hosted-pods-security-review.md): running a `Pod` outside the browser.
- [`runbook-firecracker-kvm.md`](runbook-firecracker-kvm.md): the one checklist left for the microVM lane, for a Linux/KVM
  host: exact commands, expected output, what to report.
- Per package: each `packages/*/README.md`; for building services, `packages/browsermesh-apps/docs/`.
