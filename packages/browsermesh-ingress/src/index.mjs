/**
 * @johnhenry/browsermesh-ingress -- real HTTP in, a mesh peer answers.
 *
 *   ingress:  createMeshIngress({ service | node, resolve, ... })  ->  { handle(Request): Promise<Response>, stats(), close() }
 *   provider: serveHttpOnMesh(service, handler | { fetch }, { allowFrom, limits, node?, verifyRequest? })
 *   link identity: requireLinkKey(verifySigner), nodeLinkIdentity(node)  (what is verified about the pod at the other end of a link)
 *   Node:     import { listenNode } from '@johnhenry/browsermesh-ingress/node'
 *
 * This entry imports no `node:` module (a test asserts it).
 */
export { createMeshIngress } from './ingress.mjs'
export { serveHttpOnMesh, fromSiteHandler, declineRequest, PROVIDER_LIMIT_DEFAULTS, DEFAULT_MAX_BODY_BYTES } from './provider.mjs'
export { requireLinkKey, nodeLinkIdentity, LinkKeyRefusal, LINK_KEY_REFUSALS, PEER_VERIFIED } from './peer-identity.mjs'
export {
  NAME_DENY_DEFAULTS, NAMES_PROTOCOL, NAMES_VERSIONS, NameRefusal, checkLabel, checkService, createNameTable, openNameClient, registryAllow, serveIngressNames,
} from './names.mjs'
export { INGRESS_LIMIT_DEFAULTS, parseBytes, parseDuration } from './limits.mjs'
export { IngressError, REASON_HEADER } from './errors.mjs'
export { DEFAULT_CSP, DEFAULT_FORWARD_REQUEST_HEADERS, DEFAULT_PASS_RESPONSE_HEADERS } from './headers.mjs'
export { HTTP_PROTOCOL, HTTP_VERSIONS, signedBytes, signedRequestBytes } from './wire.mjs'
