# workerd.config.capnp — self-hosted config for the isolate-pod-host spike
# (issue #185 WP2), no Cloudflare account required.
#
# Run with (workerd binary on PATH — ships inside the wrangler npm package
# at node_modules/.bin/workerd, or build/download it separately):
#
#   npx workerd serve workerd.config.capnp
#
# This serves the same worker.mjs + PodObject Durable Object as
# `wrangler dev`, on plain HTTP port 8080, against the RELAY_URL /
# SIGNALING_URL vars below (point them at a locally running
# browsermesh-servers relay + signaling pair). See README.md "Running
# self-hosted (workerd, no Cloudflare account)".
#
# Durable Object storage is `inMemory`: workerd's on-disk SQLite storage
# (`localDisk`) is explicitly documented as experimental and subject to
# breaking change, so this spike uses the in-memory mode the workerd docs
# themselves recommend "for local testing purposes" — identity/boot state
# resets whenever this process restarts, which is fine for a spike.

using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [ (name = "isolate-pod-host", worker = .podHostWorker) ],
  sockets = [ ( name = "http", address = "*:8080", http = (), service = "isolate-pod-host" ) ],
);

const podHostWorker :Workerd.Worker = (
  compatibilityDate = "2025-01-01",
  compatibilityFlags = ["nodejs_compat"],

  modules = [
    (name = "worker.mjs", esModule = embed "src/worker.mjs"),
    (name = "pod-object.mjs", esModule = embed "src/pod-object.mjs"),
    (name = "ws-transport.mjs", esModule = embed "src/ws-transport.mjs"),
    (name = "worker-websocket.mjs", esModule = embed "src/worker-websocket.mjs"),
    (name = "identity-jwk.mjs", esModule = embed "src/identity-jwk.mjs"),
  ],

  durableObjectNamespaces = [
    (className = "PodObject", uniqueKey = "browsermesh-isolate-pod-host-spike-podobject"),
  ],
  durableObjectStorage = (inMemory = void),

  bindings = [
    (name = "POD", durableObjectNamespace = "PodObject"),
    (name = "RELAY_URL", text = "ws://localhost:8788"),
    (name = "SIGNALING_URL", text = "ws://localhost:8787"),
    (name = "DISCOVERY_CHANNEL", text = "pod-discovery"),
  ],
);

# NOTE: this hand-written module list does not go through wrangler/esbuild's
# bundler, so it CANNOT resolve the bare specifiers
# `@johnhenry/browsermesh-pod` / `@johnhenry/browsermesh-primitives` the way
# `wrangler dev` does via node_modules. To actually run this config you have
# two options, both outside the scope of what this spike automates:
#   1. Pre-bundle with esbuild (same bundling wrangler does under the hood)
#      into a single embedded module and reference that instead, or
#   2. Vendor packages/browsermesh-pod and packages/browsermesh-primitives'
#      .mjs files in as additional `embed` modules with matching relative
#      import specifiers.
# `wrangler dev` / `wrangler deploy --dry-run` (both exercised by
# `npm test` and the dry-run check in this spike) already prove the worker
# bundles and runs correctly; this file documents the self-hosted path and
# its one extra step rather than re-implementing esbuild bundling by hand.
