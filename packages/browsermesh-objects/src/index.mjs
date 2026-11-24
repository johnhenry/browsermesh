/**
 * @johnhenry/browsermesh-objects -- wsh's remote-object layer over a mesh protocol channel.
 *
 *   serve:    exposeObjectsOnMesh(service | channelFactory, { roots, allow, ... })
 *   consume:  openObjectsOnMesh(channel | service, peer, opts)  ->  { roots, close }
 *
 * The wsh helpers that work on the references (`get`, `set`, `call`, `on`, `snapshot`, `use`, `release`)
 * come from `@johnhenry/wsh/objects` and are not re-exported.
 */
export { exposeObjectsOnMesh } from './serve.mjs'
export { openObjectsOnMesh, ObjectsOnMeshError } from './open.mjs'
export { OBJECT_ACTIONS, actionFor } from './actions.mjs'
export { whoFor, podIdOf } from './who.mjs'
export { duplexOverChannel, DEFAULT_MAX_PENDING_SENDS } from './duplex.mjs'
