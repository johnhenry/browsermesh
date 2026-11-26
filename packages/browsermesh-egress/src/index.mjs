/**
 * @johnhenry/browsermesh-egress -- a pod lends its network access to peers that hold a grant.
 *
 *   provider: createMeshEgress({ service, registry, dial, resolve, exchange?, dialUdp?, sets?, wide?, limits?, ... })  ->  { start(), stop(), stats(), recheck() }
 *   consumer: connectEgress(service, providerPodId, { limits?, signRequest? })  ->  { connect(host, port), lookup(name), fetch(url, init), udp(host, port), asBackend(), close() }
 *   Node:     import { nodeDialer } from '@johnhenry/browsermesh-egress/node'   // dial, dialUdp, resolve and exchange on wsh's address guard
 *
 * This entry imports no `node:` module and no wsh (a test asserts it): the consumer runs in a browser tab, and the provider
 * core takes its network as the `dial`, `dialUdp`, `resolve` and `exchange` options.
 */
export { createMeshEgress, DEFAULT_BLOCKED_PORTS, DEFAULT_BLOCKED_UDP_PORTS, WIDE_ACKNOWLEDGEMENT } from './provider.mjs'
export { connectEgress, CONSUMER_LIMIT_DEFAULTS } from './consumer.mjs'
export { EgressBackend } from './backend.mjs'
export { EgressError, REFUSAL_CODES, BUDGET_NAMES, END_REASONS, LINK_CODES } from './errors.mjs'
export { EGRESS_LIMIT_DEFAULTS, parseBytes, parseDuration } from './limits.mjs'
export { EGRESS_SCOPES, parseSetEntry, compileSets } from './destination.mjs'
export { EGRESS_PROTOCOL, EGRESS_VERSIONS, EGRESS_CONSUMER, signedRequestBytes } from './wire.mjs'
