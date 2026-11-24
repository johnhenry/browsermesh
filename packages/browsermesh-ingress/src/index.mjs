/**
 * @johnhenry/browsermesh-ingress -- real HTTP in, a mesh peer answers.
 *
 *   ingress:  createMeshIngress({ service | node, resolve, ... })  ->  { handle(Request): Promise<Response>, stats(), close() }
 *   provider: serveHttpOnMesh(service, handler | { fetch }, { allowFrom, limits })
 *   Node:     import { listenNode } from '@johnhenry/browsermesh-ingress/node'
 *
 * This entry imports no `node:` module (a test asserts it).
 */
export { createMeshIngress } from './ingress.mjs'
export { serveHttpOnMesh, fromSiteHandler, PROVIDER_LIMIT_DEFAULTS } from './provider.mjs'
export { INGRESS_LIMIT_DEFAULTS, parseBytes, parseDuration } from './limits.mjs'
export { IngressError, REASON_HEADER } from './errors.mjs'
export { DEFAULT_CSP, DEFAULT_FORWARD_REQUEST_HEADERS, DEFAULT_PASS_RESPONSE_HEADERS } from './headers.mjs'
export { HTTP_PROTOCOL, HTTP_VERSIONS, signedBytes } from './wire.mjs'
