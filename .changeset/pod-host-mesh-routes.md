---
"@johnhenry/browsermesh-apps": minor
---

Add an HTTP-shaped view of the pod host service (issue #185 control-surface item 3), two ways: `pod-host-routes.mjs` (`POD_HOST_ROUTES`/`matchPodHostRoute()`, `createPodHostRouter()`, `podHostFetch()`) projects the eight verbs onto `mesh://` routes, mounted host-side via `createPodHostMeshRpcHandler()` over the existing `createMeshRpcService({onRequest})` slot (no change needed to `mesh-fetch.mjs`/`mesh-rpc.mjs` — that hook was already composable); `pod-host-gateway.mjs` (`createPodHostGatewayHandler()`, `serveNodeGateway()`) fronts the same control surface with a Web-standard `Request -> Response` handler and a real `node:http` adapter, so pods can be driven from entirely outside the mesh under the gateway's own mesh identity, gated by an operator-supplied `auth()` callback (no default-open gateway). Both reuse `pod-host-service.mjs`'s exact `checkAccess()` gate and status-code mapping rather than re-implementing access control.
