/**
 * Shared fixtures for the `createMeshNode({ realm })` tests: a realm (descriptor, issuer, credentials) built with the realm
 * package, and a few small helpers. `@johnhenry/browsermesh-realm` is a devDependency of apps: never a static import of src/.
 */
import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import { createDescriptor, signDescriptor, issueCredential, publicKeyOf } from '@johnhenry/browsermesh-realm'

export const HOUR = 3600
export const RELAY = 'wss://relay.invalid'
export const nowS = () => Math.floor(Date.now() / 1000)
/** `mesh:link:connect` is what the default access watcher re-checks: a role that omits it loses its link at the next re-check. */
export const ROLES = {
  guest: ['mesh:link:connect', 'protocol:mcp:open'],
  member: ['mesh:link:connect', 'mcp:search:call', 'objects:window:get', 'protocol:mcp:open'],
  editor: ['mesh:link:connect', 'notes:doc:edit'],
  relay: ['mesh:link:connect', 'protocol:mcp:open', 'egress:tcp:connect'],
}
export const RENDEZVOUS = { signaling: [], relays: [RELAY], ice: [], bootstrap: [] }
export const POLICY_ROLES = { guest: ROLES.guest, member: ROLES.member, editor: ROLES.editor }

export async function waitFor(fn, timeoutMs = 4000, what = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}
export const quiet = (ms = 80) => new Promise((r) => setTimeout(r, ms))

export async function makeRealm(over = {}) {
  const root = await PodIdentity.generate()
  const issuer = await PodIdentity.generate()
  const rootKey = await publicKeyOf(root)
  const d = await createDescriptor({
    name: 'it realm', serial: 1, epoch: 0, mode: 'invite', root: { key: rootKey, chain: [] },
    issuers: [{ key: await publicKeyOf(issuer), notAfter: nowS() + 30 * 86400 }], roles: ROLES, rendezvous: RENDEZVOUS, ttl: 86400, ...over,
  })
  const signed = await signDescriptor(d, root)
  /** A later descriptor of the same realm, signed by the root. */
  const sign = async (fields) => signDescriptor(await createDescriptor({
    name: 'it realm', serial: 1, epoch: 0, mode: 'invite', root: { key: rootKey, chain: [] },
    issuers: d.issuers, roles: ROLES, rendezvous: RENDEZVOUS, ttl: 86400, ...fields,
  }), root)
  const credential = async (subject, o = {}) => (await issueCredential({
    realm: d.id, subject, role: 'member', serial: 1, notBefore: nowS() - 10, notAfter: nowS() + HOUR, epoch: d.epoch, ...o,
  }, issuer)).text
  return { id: d.id, descriptor: signed.descriptor, text: signed.text, sign, credential }
}

/** The `realm` option of a host (or a dialler: pass `credential` later with `node.realm.setCredential`). */
export const realmOption = (realm, over = {}) => ({ pinnedId: realm.id, descriptor: realm.text, policy: { [realm.id]: { roles: POLICY_ROLES } }, ...over })

/** Is `scope` ("resource:action") allowed for `key` on the host `node`'s registry? */
export function allowed(node, key, scope) {
  const i = scope.lastIndexOf(':')
  return node.registry.checkAccess(key, scope.slice(0, i), scope.slice(i + 1)).allowed
}
