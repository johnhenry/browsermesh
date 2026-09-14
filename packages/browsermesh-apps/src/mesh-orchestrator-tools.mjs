/**
 * mesh-orchestrator-tools.mjs -- Phase 4 of the agent-runtime plan (issues
 * #90/#92): registers `orchestrator.mjs`'s 8 real `Meshctl*Tool` classes
 * (`MeshctlPodsTool`/`MeshctlStatusTool`/`MeshctlExecTool`/`MeshctlDeployTool`/
 * `MeshctlTopTool`/`MeshctlComputeTool`/`MeshctlExposeTool`/`MeshctlDrainTool`,
 * built via that file's own `createMeshctlTools(orchestrator)` helper) into a
 * `compat.mjs` `BrowserToolRegistry` (Phase 1), wired against a real, attached
 * `MeshOrchestrator` (Phase 3, `mesh-orchestrator.mjs`'s `createOrchestratorService()`).
 * Once registered, `agent-runtime.mjs`'s `createAgentRuntime({registry, llmFn})`
 * (Phase 2) can dispatch LLM-requested `meshctl_*` tool calls straight through
 * to a real mesh -- this is the file that finally connects all three prior
 * phases end to end.
 *
 * This is a standalone composition-root helper, the same category as
 * `agent-runtime.mjs` itself -- not a `MeshService`, no `attach()`/`ctx`. A
 * caller who already has both a `BrowserToolRegistry` and an attached
 * orchestrator (e.g. `node.orchestrator.api` from `createMeshNode({
 * enableOrchestrator: true })`) calls `registerOrchestratorTools(registry,
 * node.orchestrator.api)` directly; `createMeshNode({ enableAgentRuntime: true,
 * enableOrchestrator: true })` also wires this internally (see
 * `mesh-bootstrap.mjs`'s own doc comment for that opt-in's exact shape and its
 * `enableAgentRuntime`-without-`enableOrchestrator` decision).
 *
 * ---------------------------------------------------------------------------
 * TWO ACCEPTED SHAPES FOR THE `orchestrator` ARGUMENT -- AND WHY THAT MATTERS
 * FOR `meshctl_exec`/`meshctl_deploy`/`meshctl_drain`'S AUTHORIZATION
 *
 * `Meshctl*Tool`'s real constructor (`orchestrator.mjs`) is `constructor(orchestrator)`,
 * storing whatever is passed in a private field and calling plain methods on
 * it (`this.#orchestrator.execOnPod(...)`, `.listPods(...)`, etc.) -- it never
 * checks `instanceof MeshOrchestrator`, so any object exposing the right method
 * names works. This file accepts EITHER:
 *
 *   1. The mesh-orchestrator.mjs SERVICE's own `api` (e.g. `node.orchestrator.api`,
 *      or `createOrchestratorService().attach(peerNode, ctx).api` directly) --
 *      detected by the presence of `.orchestrator` (the raw instance) alongside
 *      `execOnPod`/`deploySkill`/`drainPod`/`listPods`/`getPodStatus`/`topPods`.
 *      **This is the recommended, and expected, shape** -- see "GATING" below.
 *   2. A raw `MeshOrchestrator` instance directly (e.g. `node.orchestrator.api.orchestrator`,
 *      or a hand-constructed `new MeshOrchestrator({...})` never wrapped by
 *      `createOrchestratorService()` at all) -- detected by the presence of
 *      `execOnPod`/`deploySkill`/`drainPod`/`listPods`/`getPodStatus`/`topPods`/
 *      `runComputeTask`/`exposePod` all directly on the object itself (no
 *      `.orchestrator` wrapper).
 *
 * GATING -- why shape (1) is preferred, and what changes if shape (2) is used
 * instead:
 *
 * `mesh-orchestrator.mjs`'s own doc comment (Phase 3) already flagged this
 * exactly: "A future phase wiring Meshctl*Tool into an LLM-drivable registry
 * should prefer this service's own gated api.execOnPod/api.deploySkill/
 * api.drainPod (...) for any tool surface an untrusted remote actor could
 * ultimately trigger; api.orchestrator itself does not re-add the gate
 * MeshOrchestrator's own methods never had." Concretely: `MeshOrchestrator
 * .execOnPod()`/`.deploySkill()`/`.drainPod()` (the RAW methods) only ever
 * reach a remote pod via a callback pre-registered through the raw instance's
 * own `addPeer()` (or `remoteSessionBroker`/`runtimeRegistry`, neither wired
 * by this plan -- see mesh-orchestrator.mjs's header) -- if such a callback IS
 * registered, calling the raw method invokes it directly, in-process, with NO
 * authorization check at all (`checkAccess()` only guards the WIRE protocol's
 * inbound handler, which the raw path never goes through). The service's
 * `api.execOnPod`/`api.deploySkill`/`api.drainPod`, by contrast, always
 * dispatch a real `'orchestrator-request'` over the wire to the target peer
 * (unless the target is this node itself, a documented no-network shortcut)
 * and that peer's own `checkAccess(fromPubKey, 'orchestrator', action)` gate
 * decides whether to honor it -- the actual, real authorization path this
 * whole plan's "risky, peer-initiated action" design exists for.
 *
 * So: when shape (1) (the service `api`) is supplied, this file wires
 * `meshctl_exec`/`meshctl_deploy`/`meshctl_drain` through `api.execOnPod`/
 * `api.deploySkill`/`api.drainPod` specifically (real wire dispatch + the
 * target's real `checkAccess()` gate for a remote target; a genuine no-network
 * shortcut for a self-targeted call) -- NOT through `api.orchestrator`'s raw
 * methods, even though the raw instance is reachable and would otherwise be
 * the more literal reading of "construct `Meshctl*Tool` against the raw
 * instance." `meshctl_pods`/`meshctl_status`/`meshctl_top` (local-only
 * aggregation, never gated even at the service layer -- see
 * mesh-orchestrator.mjs's own "AUTHORIZATION" section) and `meshctl_compute`/
 * `meshctl_expose` (see next section) still go straight to the raw instance,
 * since the service exposes no gated equivalent for any of those five.
 *
 * When shape (2) (a raw orchestrator, no service) is supplied instead, ALL
 * eight tools run straight off the raw instance with no gate whatsoever --
 * this file does not invent authorization that has no wire protocol to
 * enforce it. This is a legitimate, intentional shape for a single
 * trusted-local-operator use case (no mesh service attached at all, e.g. a
 * standalone `MeshOrchestrator` driving only this node's own pod), just not
 * the one a caller wiring both `enableOrchestrator` and `enableAgentRuntime`
 * through `createMeshNode()` gets -- that path always supplies shape (1).
 *
 * ---------------------------------------------------------------------------
 * `meshctl_compute`/`meshctl_expose` -- NOT WIRED BY PHASE 3 AT ALL, NOTED
 * HERE RATHER THAN SILENTLY WORKED AROUND
 *
 * `MeshctlComputeTool`/`MeshctlExposeTool` call `orchestrator.runComputeTask()`/
 * `orchestrator.exposePod()` -- both are real, implemented methods on
 * `MeshOrchestrator` (confirmed directly in `orchestrator.mjs`: `runComputeTask()`
 * resolves a target via `ResourceScorer`/`#resourceRegistry`/`#knownPeers` and
 * either runs locally (`peerNode.exec()`) or through whatever peer callback is
 * registered; `exposePod()` is a purely local bookkeeping call recording an
 * exposed-service address, optionally announced via `serviceAdvertiser` if one
 * were ever wired). Neither one, however, is part of `mesh-orchestrator.mjs`'s
 * own wire protocol -- Phase 3's `RISKY_ACTIONS` is exactly `['exec', 'deploy',
 * 'drain']` (`mesh-orchestrator.mjs`), so there is no `api.runComputeTask`/
 * `api.exposePod` gated equivalent to prefer the way there is for exec/deploy/
 * drain. Both tools are therefore ALWAYS wired straight to the raw instance's
 * own methods here, regardless of which of the two input shapes above is
 * supplied -- they run local-only, ungated, exactly like `meshctl_pods`/
 * `meshctl_status`/`meshctl_top` already do at the service layer. A future
 * phase wanting a real gated/remote-dispatchable `meshctl_compute`/
 * `meshctl_expose` would need to extend `mesh-orchestrator.mjs`'s own wire
 * protocol first (out of scope here, exactly per this plan's Phase 4 section).
 *
 * ---------------------------------------------------------------------------
 * No browser-only imports at module level.
 */

import { BrowserToolRegistry } from './compat.mjs'
import { createMeshctlTools } from './orchestrator.mjs'

/**
 * @param {unknown} x
 * @returns {boolean} true if `x` looks like `mesh-orchestrator.mjs`'s
 *   service `api` -- see module doc comment's "TWO ACCEPTED SHAPES" section.
 */
function looksLikeOrchestratorServiceApi(x) {
  return !!x
    && x.orchestrator && typeof x.orchestrator === 'object'
    && typeof x.execOnPod === 'function'
    && typeof x.deploySkill === 'function'
    && typeof x.drainPod === 'function'
    && typeof x.listPods === 'function'
    && typeof x.getPodStatus === 'function'
    && typeof x.topPods === 'function'
}

/**
 * @param {unknown} x
 * @returns {boolean} true if `x` looks like a raw `MeshOrchestrator` instance
 *   itself -- see module doc comment's "TWO ACCEPTED SHAPES" section.
 */
function looksLikeRawOrchestrator(x) {
  return !!x
    && typeof x.execOnPod === 'function'
    && typeof x.deploySkill === 'function'
    && typeof x.drainPod === 'function'
    && typeof x.listPods === 'function'
    && typeof x.getPodStatus === 'function'
    && typeof x.topPods === 'function'
    && typeof x.runComputeTask === 'function'
    && typeof x.exposePod === 'function'
}

/**
 * Build the object actually handed to `createMeshctlTools()` -- see module
 * doc comment's "GATING" section for exactly which methods route through the
 * service's gated wire dispatch vs. straight to the raw instance, and why.
 * @param {object} orchestrator - Either shape from the module doc comment.
 * @returns {object} duck-typed stand-in for a raw `MeshOrchestrator`
 */
function buildToolFacade(orchestrator) {
  if (looksLikeOrchestratorServiceApi(orchestrator)) {
    const raw = orchestrator.orchestrator
    return {
      // meshctl_exec/meshctl_deploy/meshctl_drain -- real wire dispatch +
      // the target's real checkAccess() gate for a remote target (a genuine
      // no-network shortcut for a self-targeted call). See "GATING" above.
      execOnPod: (...args) => orchestrator.execOnPod(...args),
      deploySkill: (...args) => orchestrator.deploySkill(...args),
      drainPod: (...args) => orchestrator.drainPod(...args),
      // meshctl_pods/meshctl_status/meshctl_top -- local-only aggregation,
      // never gated even at the service layer -- straight to the raw
      // instance, identical to what api.listPods()/etc. already do.
      listPods: (...args) => raw.listPods(...args),
      getPodStatus: (...args) => raw.getPodStatus(...args),
      topPods: (...args) => raw.topPods(...args),
      // meshctl_compute/meshctl_expose -- no gated equivalent exists at the
      // service layer at all (see module doc comment). Straight to the raw
      // instance either way.
      runComputeTask: (...args) => raw.runComputeTask(...args),
      exposePod: (...args) => raw.exposePod(...args),
      // MeshctlExposeTool reads `this.#orchestrator.peerNode` directly for
      // its own default-podId fallback.
      get peerNode() { return raw.peerNode },
    }
  }
  if (looksLikeRawOrchestrator(orchestrator)) {
    // No wrapping service supplied -- every action, including exec/deploy/
    // drain, runs straight off the raw instance with no gate. See module doc
    // comment's "GATING" section for exactly what that means.
    return orchestrator
  }
  throw new TypeError(
    'registerOrchestratorTools: orchestrator must be either the mesh-orchestrator.mjs ' +
    'service\'s own `api` (e.g. node.orchestrator.api -- has `.orchestrator` plus ' +
    'execOnPod/deploySkill/drainPod/listPods/getPodStatus/topPods) or a raw MeshOrchestrator ' +
    'instance (orchestrator.mjs, has all eight of those methods directly) -- got ' +
    (orchestrator && orchestrator.constructor ? orchestrator.constructor.name : String(orchestrator))
  )
}

/**
 * Construct all 8 `Meshctl*Tool` instances (`orchestrator.mjs`'s own
 * `createMeshctlTools()`) against `orchestrator` and register each into
 * `registry`. See module doc comment for the full design writeup (the two
 * accepted `orchestrator` shapes, the exec/deploy/drain gating decision, and
 * the compute/expose "not wired by Phase 3 at all" note).
 *
 * @param {import('./compat.mjs').BrowserToolRegistry} registry - REQUIRED.
 *   Duck-typed (`.register` a function), matching this package's established
 *   "duck-type collaborators, don't require exact class identity" convention
 *   (see `agent-runtime.mjs`'s own `looksLikeRegistry()`).
 * @param {object} orchestrator - REQUIRED. Either `mesh-orchestrator.mjs`'s
 *   service `api` (recommended -- e.g. `node.orchestrator.api`) or a raw
 *   `MeshOrchestrator` instance -- see module doc comment.
 * @returns {import('./orchestrator.mjs').BrowserTool[]} the 8 registered tool
 *   instances, in `createMeshctlTools()`'s own order (pods, status, exec,
 *   deploy, top, compute, expose, drain).
 */
export function registerOrchestratorTools(registry, orchestrator) {
  if (!registry || typeof registry.register !== 'function') {
    throw new TypeError(
      'registerOrchestratorTools: registry is required (a BrowserToolRegistry-shaped object ' +
      'implementing register(tool) -- see compat.mjs\'s BrowserToolRegistry) -- got ' +
      (registry && registry.constructor ? registry.constructor.name : String(registry))
    )
  }
  const facade = buildToolFacade(orchestrator)
  const tools = createMeshctlTools(facade)
  for (const tool of tools) {
    registry.register(tool)
  }
  return tools
}

/**
 * Convenience factory: build a brand-new `BrowserToolRegistry` and
 * pre-populate it with all 8 `Meshctl*Tool`s via `registerOrchestratorTools()`.
 * Equivalent to `registerOrchestratorTools(new BrowserToolRegistry(), orchestrator)`,
 * for a caller who doesn't already have a registry of their own to reuse (see
 * `registerOrchestratorTools()` directly if you do -- e.g. to add
 * non-orchestrator tools into the same registry alongside these 8).
 *
 * @param {object} orchestrator - See `registerOrchestratorTools()`.
 * @returns {import('./compat.mjs').BrowserToolRegistry}
 */
export function createOrchestratorToolRegistry(orchestrator) {
  const registry = new BrowserToolRegistry()
  registerOrchestratorTools(registry, orchestrator)
  return registry
}
