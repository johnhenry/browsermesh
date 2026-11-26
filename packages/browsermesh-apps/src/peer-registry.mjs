import { silentCatch } from './silent-catch.mjs'
import { matchScope } from '@johnhenry/browsermesh-primitives'
/**
 * peer-registry.mjs --Unified peer registry with permission management.
 *
 * Wraps MeshPeerManager, TrustGraph, and MeshACL into a single facade that
 * coordinates peer lifecycle, trust, and access control. All three subsystems
 * are accepted via dependency injection — the registry creates defaults when
 * they are not provided.
 *
 * No browser-only imports at module level.
 *
 * Run tests:
 *   cd packages/browsermesh-apps && node --import ./test/_setup-globals.mjs --test test/peer-registry.test.mjs
 */

// ---------------------------------------------------------------------------
// Capability tokens (Phase 5 -- real granting/revocation, layered under the
// existing ACL template mechanism, not replacing it)
// ---------------------------------------------------------------------------

/**
 * Duck-typed default token, used only when no `tokenFactory` is injected.
 * Shaped to satisfy both this module's own default `CapabilityValidator`
 * fallback below AND the real `@johnhenry/browsermesh-core` `CapabilityValidator`
 * (whose `register()`/`revokeTree()`/`validate()` only ever touch `.id`,
 * `.revoked`, `.parentId`, `.resource`, `.permissions`, `.constraints`,
 * `.isExpired()`, `.hasPermission()`, `.revoke()` -- nothing constructor-specific)
 * -- so real callers (see `mesh-bootstrap.mjs`) can inject the real
 * `CapabilityToken` class as `tokenFactory` for the genuine, tested class,
 * while this file itself stays decoupled from `-core` at the module level,
 * matching the existing peerManager/trustGraph/acl DI pattern in this class.
 */
/** The longest a platform timer can wait (a 32-bit signed millisecond count). */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

/**
 * Namespaces whose scope grammar is written down, because wsh's capability notation (`spec/capabilities.md`) has the
 * same forms and the two are meant to agree: `objects:ROOT[:OP]` and `mcp:TOOL`. `matchScope` reads a missing or empty
 * segment as `*`, so a grant of `objects:` (no root) or `mcp:` (no tool) would silently cover every root or tool; the
 * notation refuses such an entry, and so does the registry. Everything else is the registry's own and is not checked.
 *
 *   objects:ROOT          every operation on ROOT          (ROOT is `*`, or a name; no empty root)
 *   objects:ROOT:OP       OP is get, call, set or on; `*` is the registry's own wildcard for every operation
 *   mcp:TOOL              TOOL is `*` or a name; `mcp:TOOL:call` is the same grant spelled with its action
 */
const SCOPE_NAME_RE = /^[A-Za-z0-9_$][A-Za-z0-9._$-]{0,127}$/
const OBJECT_OPS = new Set(['get', 'call', 'set', 'on', '*'])

/** @param {unknown} scope @returns {string|null} why the scope may not be granted, or null */
function grantRefusal(scope) {
  if (typeof scope !== 'string' || scope === '') return 'a scope is a non-empty string'
  const parts = scope.split(':')
  if (parts[0] === 'objects') {
    if (parts.length < 2 || parts.length > 3) return 'objects:ROOT[:OP]'
    if (parts[1] !== '*' && !SCOPE_NAME_RE.test(parts[1])) return 'objects: names a root'
    if (parts.length === 3 && !OBJECT_OPS.has(parts[2])) return 'objects:ROOT:OP, OP is get, call, set or on'
  } else if (parts[0] === 'mcp') {
    if (parts.length < 2 || parts.length > 3) return 'mcp:TOOL[:call]'
    if (parts[1] !== '*' && !SCOPE_NAME_RE.test(parts[1])) return 'mcp: names a tool'
    if (parts.length === 3 && parts[2] !== 'call' && parts[2] !== 'list' && parts[2] !== '*') return 'mcp:TOOL[:call|list]'
  }
  return null
}

/**
 * Scope families a realm never grants unless the host's policy names them: the ones that lend the host's network,
 * serve its HTTP, run its pods or open its shells (docs/design/realms.md, principle 2).
 */
const REALM_SENSITIVE_PREFIXES = ['egress:', 'ingress:', 'pod-host', 'wsh-']

/**
 * Why a scope may not come from a realm, or null. A realm scope is concrete: under `matchScope` a wildcard segment or
 * an empty or missing one matches anything, so such a scope is refused here, on top of the registry's own grammar.
 * @param {unknown} scope
 */
function realmScopeRefusal(scope) {
  const why = grantRefusal(scope)
  if (why) return why
  const parts = scope.split(':')
  if (parts.length < 3) return 'a realm scope names three segments or more (a short scope matches everything beneath it)'
  if (parts.some((part) => part === '' || part === '*')) return 'a realm scope has no wildcard or empty segment'
  return null
}

/** The sensitive prefix a scope begins with, or null. */
function sensitivePrefix(scope) {
  return REALM_SENSITIVE_PREFIXES.find((prefix) => scope.startsWith(prefix)) ?? null
}

/**
 * Whether a host allow list admits a (concrete) realm scope. A sensitive scope is admitted only by a pattern that
 * itself begins with the same sensitive prefix: `*:*:*` does not name `egress:`.
 * @param {string[]} allow @param {string} scope
 * @returns {'ok'|'scope-not-allowed'|'sensitive-scope-not-named'}
 */
function realmAdmits(allow, scope) {
  const prefix = sensitivePrefix(scope)
  if (prefix === null) return allow.some((pattern) => matchScope(pattern, scope)) ? 'ok' : 'scope-not-allowed'
  if (allow.some((pattern) => pattern.startsWith(prefix) && matchScope(pattern, scope))) return 'ok'
  return allow.some((pattern) => matchScope(pattern, scope)) ? 'sensitive-scope-not-named' : 'scope-not-allowed'
}

/** Whether `grantCapabilities` would accept this scope. */
export function isGrantableScope(scope) {
  return grantRefusal(scope) === null
}

let _localCapTokenSeq = 0
class _DefaultCapabilityToken {
  constructor({ issuer, holder, resource, permissions, constraints = {}, parentId = null, createdAt, expiresAt = null }) {
    this.id = `peercap_${Date.now()}_${++_localCapTokenSeq}`
    this.issuer = issuer
    this.holder = holder
    this.resource = resource
    this.permissions = [...permissions]
    this.constraints = { ...constraints }
    this.parentId = parentId
    this.createdAt = createdAt || Date.now()
    this.expiresAt = expiresAt
    this.revoked = false
  }

  isExpired(now = Date.now()) {
    return this.expiresAt !== null && this.expiresAt !== undefined && now >= this.expiresAt
  }

  hasPermission(perm) {
    return this.permissions.includes(perm)
  }

  revoke() {
    this.revoked = true
  }
}

// ---------------------------------------------------------------------------
// PeerRegistry
// ---------------------------------------------------------------------------

/**
 * Unified peer registry combining peer management, trust, and ACL.
 *
 * Every peer operation coordinates across all three subsystems so callers
 * never need to manually keep them in sync.
 */
export class PeerRegistry {
  /** @type {import('@johnhenry/browsermesh-core').MeshPeerManager} */
  #peerManager

  /** @type {import('@johnhenry/browsermesh-core').TrustGraph} */
  #trustGraph

  /** @type {import('@johnhenry/browsermesh-core').MeshACL} */
  #acl

  /** @type {string} */
  #localPodId

  /** @type {Function} */
  #onLog
  /** @type {Map<string, number>} */
  #observedTrust = new Map()

  /**
   * Real capability tokens issued through `grantCapabilities()`, tracked so
   * `revokeCapabilities()` can find and revoke the matching token(s) later,
   * and so `checkAccess()` can consult live revocation status. Keyed by
   * peer pubKey -> (exact granted scope string -> token). Only scopes
   * granted via `grantCapabilities()` get an entry here; peers configured
   * purely via `updatePermissions()`/`addEntry()`/default templates have no
   * tracked tokens and are therefore governed by the ACL alone, unaffected
   * by this mechanism (see checkAccess()).
   *
   * @type {Map<string, Map<string, object>>}
   */
  #capabilityTokens = new Map()

  /** @type {Set<Function>} */
  #accessListeners = new Set()

  /** Clock for expiry: `{ now, setTimeout, clearTimeout }`. Injected in tests. */
  #clock

  /** The single timer armed for the nearest grant expiry, if any. */
  #expiryTimer = null

  /** The expiry (ms epoch) `#expiryTimer` is armed for. */
  #expiryAt = null

  /** Tokens whose expiry has been announced, so each is announced once. @type {WeakSet<object>} */
  #announcedExpiry = new WeakSet()

  /**
   * The realm grant source: peer -> (realm id + role) -> grant. Kept apart from `#capabilityTokens` and the ACL so the
   * operator's grants are never read or changed by it; never persisted. See `grantRealmScopes()`.
   * @type {Map<string, Map<string, { realmId: string, serial: string|number, peerKey: string, role: string, scopes: string[], notAfter: number, epoch: number }>>}
   */
  #realmGrants = new Map()

  /** The host's realm policy: realm id -> (role -> allow list of scope patterns). Empty: no realm is honoured. @type {Map<string, Map<string, string[]>>} */
  #realmPolicy = new Map()

  /** Called for every scope (or whole grant) a realm asked for and the policy refused. */
  #onRealmGrantDropped

  /** No realm grant expires before this (ms epoch); it may be earlier than the real nearest, never later. */
  #realmNextExpiry = null

  /** Validates/revokes tokens -- real `CapabilityValidator` when injected, a
   * duck-typed equivalent otherwise. @type {{ register: Function, revokeTree: Function }} */
  #capabilityValidator

  /** Constructs a token object for grantCapabilities() -- real `CapabilityToken`
   * when injected, `_DefaultCapabilityToken` otherwise. @type {Function} */
  #tokenFactory

  /**
   * @param {object} opts
   * @param {string} opts.localPodId - Owner identity used for ACL and trust edges
   * @param {import('@johnhenry/browsermesh-core').MeshPeerManager} [opts.peerManager]
   * @param {import('@johnhenry/browsermesh-core').TrustGraph} [opts.trustGraph]
   * @param {import('@johnhenry/browsermesh-core').MeshACL} [opts.acl]
   * @param {import('@johnhenry/browsermesh-core').CapabilityValidator} [opts.capabilityValidator]
   *   Backs the real granting/revocation path for `grantCapabilities()`/
   *   `revokeCapabilities()` (Phase 5). Defaults to a lightweight in-package
   *   equivalent when omitted, so this class stays usable without `-core`
   *   installed -- inject the real class (see `mesh-bootstrap.mjs`) for the
   *   genuine, tested implementation.
   * @param {Function} [opts.tokenFactory] - `(opts) => token`, used to construct
   *   the token registered with `capabilityValidator` on each grant. Defaults to
   *   a small duck-typed equivalent of `@johnhenry/browsermesh-core`'s
   *   `CapabilityToken`; pass `(opts) => new CapabilityToken(opts)` to use the
   *   real class.
   * @param {Function} [opts.onLog] - Logging callback (level, msg)
   * @param {{ now: () => number, setTimeout: Function, clearTimeout: Function }} [opts.clock] -
   *   The time source for grant expiry (`now()` in ms epoch, and a timer). Defaults to `Date.now` and the
   *   platform timer (unref'd, so it never keeps a process alive). Tests inject their own.
   * @param {Record<string, { roles: Record<string, string[]> }>} [opts.realmPolicy] - Which realm ids this host
   *   honours and, per role, the allow list of scope patterns a realm may grant under it (see `setRealmPolicy()`).
   *   Default: none, so no realm grants anything.
   * @param {(dropped: { realmId: string, serial: string|number, peerKey: string, role: string, scope: string|null, reason: string }) => void} [opts.onRealmGrantDropped] -
   *   Told of every scope the policy refused (`scope` is null when the whole grant was: an unhonoured realm or role).
   */
  constructor({ localPodId, peerManager, trustGraph, acl, capabilityValidator, tokenFactory, onLog, clock, realmPolicy, onRealmGrantDropped }) {
    if (!localPodId || typeof localPodId !== 'string') {
      throw new Error('localPodId is required and must be a non-empty string')
    }

    this.#localPodId = localPodId
    this.#onLog = onLog || (() => {})
    this.#onRealmGrantDropped = typeof onRealmGrantDropped === 'function' ? onRealmGrantDropped : () => {}
    if (realmPolicy !== undefined) this.#setPolicyUnchecked(realmPolicy)

    // Accept injected instances or create bare defaults.
    // Callers importing from the actual modules can pass real instances;
    // for testing, lightweight duck-typed stubs work just as well.
    this.#peerManager = peerManager ?? this.#createDefaultPeerManager()
    this.#trustGraph = trustGraph ?? this.#createDefaultTrustGraph()
    this.#acl = acl ?? this.#createDefaultACL()
    this.#capabilityValidator = capabilityValidator ?? this.#createDefaultCapabilityValidator()
    this.#tokenFactory = tokenFactory ?? ((tokenOpts) => new _DefaultCapabilityToken(tokenOpts))
    this.#clock = clock ?? {
      now: () => Date.now(),
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
      clearTimeout: (handle) => globalThis.clearTimeout(handle),
    }
  }

  // ── Peer CRUD ───────────────────────────────────────────────────────

  /**
   * Add a peer and optionally grant initial capabilities.
   *
   * @param {string} pubKey - Peer fingerprint / public key hash
   * @param {string} [label] - Human-readable name
   * @param {string[]} [grantedCaps] - Initial capability scopes
   * @returns {import('@johnhenry/browsermesh-core').PeerState}
   */
  addPeer(pubKey, label, grantedCaps) {
    const info = {}
    if (label) info.label = label

    const peer = this.#peerManager.addPeer(pubKey, info)

    if (grantedCaps && grantedCaps.length > 0) {
      this.grantCapabilities(pubKey, grantedCaps)
    }

    this.#onLog(2, `PeerRegistry: added ${pubKey}`)
    return peer
  }

  /**
   * Remove a peer and clean up its trust edges and ACL entries.
   *
   * @param {string} pubKey
   * @returns {boolean} true if the peer existed
   */
  removePeer(pubKey) {
    const existed = this.#peerManager.removePeer(pubKey)

    // Remove trust edges originating from us to this peer
    this.#trustGraph.removeEdge(this.#localPodId, pubKey)

    // Remove ACL roster entry
    this.#acl.revokeAll(pubKey)

    // Revoke any live capability tokens issued to this peer and stop
    // tracking them -- a removed peer must not retain live tokens that a
    // later re-add under the same pubKey could otherwise inherit.
    const peerTokens = this.#capabilityTokens.get(pubKey)
    if (peerTokens) {
      for (const token of peerTokens.values()) {
        if (!token.revoked) this.#capabilityValidator.revokeTree(token.id)
      }
      this.#capabilityTokens.delete(pubKey)
      this.#scheduleExpiry()
    }

    // ... and the realm grants it holds.
    if (this.#realmGrants.delete(pubKey)) this.#scheduleExpiry()

    if (existed) {
      this.#onLog(2, `PeerRegistry: removed ${pubKey}`)
    }
    this.#emitAccessChange(pubKey, 'removed')
    return existed
  }

  /**
   * Get a single peer by public key.
   *
   * @param {string} pubKey
   * @returns {import('@johnhenry/browsermesh-core').PeerState|null}
   */
  getPeer(pubKey) {
    return this.#peerManager.getPeer(pubKey)
  }

  /**
   * List peers, optionally filtered by status or trust level.
   *
   * @param {object} [filter]
   * @param {string} [filter.status]
   * @param {number} [filter.minTrust]
   * @returns {import('@johnhenry/browsermesh-core').PeerState[]}
   */
  listPeers(filter) {
    return this.#peerManager.listPeers(filter)
  }

  // ── Permission management ───────────────────────────────────────────

  /**
   * Assign an ACL template to a peer, replacing any previous entry.
   *
   * @param {string} pubKey
   * @param {string} templateName
   */
  updatePermissions(pubKey, templateName) {
    // Remove old entry if present, then add new one
    this.#acl.removeEntry(pubKey)
    this.#acl.addEntry(pubKey, templateName)
    this.#onLog(3, `PeerRegistry: set template '${templateName}' for ${pubKey}`)
    this.#emitAccessChange(pubKey, 'updated')
  }

  /**
   * Grant additional capability scopes to a peer via a dynamic ACL template,
   * AND issue a real capability token per scope through the injected (or
   * default) `CapabilityValidator` (Phase 5). The ACL template remains the
   * mechanism `checkAccess()` primarily checks -- fully backward compatible
   * with any caller that only cares about the pre-Phase-5 ACL behavior --
   * while the token gives `revokeCapabilities()` a live revocation target
   * that `checkAccess()` additionally consults, independent of whether/when
   * the ACL template itself gets re-read.
   *
   * @param {string} pubKey
   * @param {string[]} scopes - Scopes to add (e.g. ['files:read', 'chat:write'])
   * @param {object} [opts]
   * @param {number|null} [opts.expiresAt] - Optional expiry (ms epoch) applied
   *   to newly-issued tokens for this call. Omit for no expiry.
   */
  grantCapabilities(pubKey, scopes, opts = {}) {
    // The whole list or none of it: an entry the notation does not understand is refused, the rest is not kept.
    for (const scope of scopes) {
      const why = grantRefusal(scope)
      if (why) throw new TypeError(`PeerRegistry.grantCapabilities: ${JSON.stringify(scope)} is not a scope this registry will grant (${why})`)
    }
    const templateName = `_peer_${pubKey}`
    const existing = this.#acl.getTemplate(templateName)
    const merged = existing
      ? [...new Set([...existing.scopes, ...scopes])]
      : [...scopes]

    this.#acl.addTemplate(templateName, merged, `Auto-generated for ${pubKey}`)

    // Ensure roster entry points to the per-peer template
    const entry = this.#acl.getEntry(pubKey)
    if (!entry || entry.templateName !== templateName) {
      this.#acl.removeEntry(pubKey)
      this.#acl.addEntry(pubKey, templateName)
    }

    // Issue a real capability token per scope so revocation has a live
    // target beyond the ACL template. Skip scopes that already have a live
    // (non-revoked, non-expired) token -- re-granting an already-granted
    // scope is a no-op at the token layer, matching the ACL's own
    // dedup/additive behavior above. A scope whose prior token was revoked
    // gets a fresh token (tokens are one-way revocable, never un-revoked).
    let peerTokens = this.#capabilityTokens.get(pubKey)
    if (!peerTokens) {
      peerTokens = new Map()
      this.#capabilityTokens.set(pubKey, peerTokens)
    }
    const now = this.#clock.now()
    for (const scope of scopes) {
      const current = peerTokens.get(scope)
      const currentLive = current && !current.revoked &&
        !(typeof current.isExpired === 'function' && current.isExpired(now))
      if (currentLive) continue

      const token = this.#tokenFactory({
        issuer: this.#localPodId,
        holder: pubKey,
        resource: scope,
        permissions: ['use'],
        expiresAt: opts.expiresAt ?? null,
      })
      this.#capabilityValidator.register(token)
      peerTokens.set(scope, token)
    }
    this.#scheduleExpiry()

    this.#onLog(3, `PeerRegistry: granted ${scopes.join(', ')} to ${pubKey}`)
  }

  /**
   * Revoke specific capability scopes from a peer: removes them from the ACL
   * template (if no scopes remain, removes the per-peer template and roster
   * entry -- unchanged from pre-Phase-5 behavior) AND revokes the matching
   * capability token(s) issued by `grantCapabilities()` through the
   * `CapabilityValidator`, so `checkAccess()`'s live check denies immediately
   * regardless of ACL template state.
   *
   * @param {string} pubKey
   * @param {string[]} scopes - Scopes to remove
   */
  revokeCapabilities(pubKey, scopes) {
    const templateName = `_peer_${pubKey}`
    const existing = this.#acl.getTemplate(templateName)

    if (existing) {
      const remaining = existing.scopes.filter(s => !scopes.includes(s))

      if (remaining.length === 0) {
        this.#acl.removeEntry(pubKey)
        this.#acl.removeTemplate(templateName)
      } else {
        this.#acl.addTemplate(templateName, remaining, `Auto-generated for ${pubKey}`)
        // Re-sync the roster entry
        this.#acl.removeEntry(pubKey)
        this.#acl.addEntry(pubKey, templateName)
      }
    }

    // Revoke the matching token(s), if any were issued via grantCapabilities().
    // Scoped precisely: only the exact scopes named here are touched, so a
    // different, still-granted scope for the same peer is unaffected.
    const peerTokens = this.#capabilityTokens.get(pubKey)
    if (peerTokens) {
      for (const scope of scopes) {
        const token = peerTokens.get(scope)
        if (token && !token.revoked) {
          this.#capabilityValidator.revokeTree(token.id)
        }
      }
    }

    this.#scheduleExpiry()
    this.#onLog(3, `PeerRegistry: revoked ${scopes.join(', ')} from ${pubKey}`)
    this.#emitAccessChange(pubKey, 'revoked')
  }

  /**
   * Get the current capabilities for a peer.
   *
   * @param {string} pubKey
   * @returns {{ template: string|null, scopes: string[] }}
   */
  getPeerCapabilities(pubKey) {
    const entry = this.#acl.getEntry(pubKey)
    if (!entry) return { template: null, scopes: [] }

    const tpl = this.#acl.getTemplate(entry.templateName)
    return {
      template: entry.templateName,
      scopes: tpl ? [...tpl.scopes] : [],
    }
  }

  /**
   * Check if a peer is allowed to perform an action on a resource.
   *
   * First checks the ACL template (unchanged, pre-Phase-5 behavior -- owner
   * bypass, roster/template scope matching). If the ACL allows it, ALSO
   * consults live revocation status for any capability token issued via
   * `grantCapabilities()` whose scope covers this resource/action (Phase 5):
   * a token that was granted then revoked denies access on this check, even
   * if the ACL template itself hasn't been re-read or doesn't (e.g. a
   * broader wildcard scope that revokeCapabilities()'s exact-match ACL
   * removal didn't touch). Peers/scopes never routed through
   * `grantCapabilities()` (e.g. `updatePermissions()`/`addEntry()` callers,
   * default templates) have no tracked token and are therefore governed by
   * the ACL alone, exactly as before.
   *
   * @param {string} pubKey
   * @param {string} resource
   * @param {string} action
   * @returns {{ allowed: boolean, reason?: string }}
   */
  checkAccess(pubKey, resource, action) {
    const operator = this.#checkOperator(pubKey, resource, action)
    if (operator.allowed) return operator
    // The realm source is a second, separate source: it can allow where the operator's did not, and nothing in it
    // (an expired grant, a wildcard) can deny what the operator's allows.
    const realm = this.#checkRealm(pubKey, `${resource}:${action}`)
    return realm ?? operator
  }

  /** The operator's grants: the ACL, then the live revocation status of the tokens `grantCapabilities()` issued. */
  #checkOperator(pubKey, resource, action) {
    const aclResult = this.#acl.check(pubKey, resource, action)
    if (!aclResult.allowed) return aclResult

    const scope = `${resource}:${action}`
    const peerTokens = this.#capabilityTokens.get(pubKey)
    if (peerTokens) {
      const now = this.#clock.now()
      for (const [grantedScope, token] of peerTokens) {
        if (!matchScope(grantedScope, scope)) continue
        if (token.revoked || (typeof token.isExpired === 'function' && token.isExpired(now))) {
          return { allowed: false, reason: 'capability_revoked' }
        }
      }
    }

    return aclResult
  }

  /** A live realm grant that covers `scope`, as an allowing result, or null. */
  #checkRealm(pubKey, scope) {
    const held = this.#realmGrants.get(pubKey)
    if (!held) return null
    const now = this.#clock.now()
    for (const grant of held.values()) {
      if (grant.notAfter <= now) continue
      if (grant.scopes.some((granted) => matchScope(granted, scope))) {
        return { allowed: true, reason: 'realm_grant', realmId: grant.realmId }
      }
    }
    return null
  }

  // ── Realm grants ────────────────────────────────────────────────────

  /**
   * Set which realms this host honours and what each role may be granted (docs/design/realms.md, principle 2). A
   * descriptor's role is an upper bound; this is the host's own list, and it wins. Replaces any earlier policy; grants
   * already held are cut back to what the new policy admits (an access change is announced for each peer affected). A
   * wider policy does not grant anything retroactively: a realm credential has to be presented again.
   *
   * `{ [realmId]: { roles: { [role]: ['protocol:mcp:open', 'files:*:read'] } } }`. The allow list holds scope
   * patterns, matched like every other scope. `egress:`, `ingress:`, `pod-host` and `wsh-` scopes are admitted only by
   * a pattern that itself begins that way.
   *
   * @param {Record<string, { roles: Record<string, string[]> }>} policy
   */
  setRealmPolicy(policy) {
    this.#setPolicyUnchecked(policy)
    const affected = new Set()
    for (const [peerKey, held] of this.#realmGrants) {
      for (const [slot, grant] of held) {
        const allow = this.#realmPolicy.get(grant.realmId)?.get(grant.role)
        const keep = allow ? grant.scopes.filter((scope) => realmAdmits(allow, scope) === 'ok') : []
        if (keep.length === grant.scopes.length) continue
        affected.add(peerKey)
        if (keep.length === 0) held.delete(slot)
        else grant.scopes = keep
      }
      if (held.size === 0) this.#realmGrants.delete(peerKey)
    }
    this.#scheduleExpiry()
    for (const peerKey of affected) this.#emitAccessChange(peerKey, 'realm-policy')
  }

  #setPolicyUnchecked(policy) {
    if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
      throw new TypeError('PeerRegistry realm policy: an object of realm id to { roles }')
    }
    const next = new Map()
    for (const [realmId, entry] of Object.entries(policy)) {
      const roles = entry?.roles
      if (roles === null || typeof roles !== 'object' || Array.isArray(roles)) {
        throw new TypeError(`PeerRegistry realm policy: ${JSON.stringify(realmId)} needs { roles: { role: [scope patterns] } }`)
      }
      const byRole = new Map()
      for (const [role, allow] of Object.entries(roles)) {
        if (!Array.isArray(allow) || allow.some((pattern) => typeof pattern !== 'string' || pattern === '')) {
          throw new TypeError(`PeerRegistry realm policy: ${JSON.stringify(realmId)} role ${JSON.stringify(role)} needs an array of scope patterns`)
        }
        byRole.set(role, [...allow])
      }
      next.set(realmId, byRole)
    }
    this.#realmPolicy = next
  }

  /**
   * Grant a realm credential's scopes to a peer. The realm grant source is separate from `grantCapabilities()`: it is
   * unioned with the operator's grants in `checkAccess()`, has its own expiry and epoch, is keyed by (realm, credential
   * serial, peer) and is never persisted (`toJSON()` leaves it out, `fromJSON()` restores none), so nothing a realm does
   * can extend, shorten, poison or remove a grant the operator made.
   *
   * What is stored is what the host's realm policy admits (`setRealmPolicy()`): a realm id the policy does not list
   * grants nothing, nor does a role it does not list; a scope outside the role's allow list is dropped; a sensitive
   * scope (`egress:`, `ingress:`, `pod-host`, `wsh-`) is dropped unless the allow list names it. Every drop goes to
   * `onRealmGrantDropped` and is returned. A scope that is a wildcard, or has an empty or missing segment (so it would
   * match anything under `matchScope`), is not dropped but refused: the call throws and nothing is granted.
   *
   * Renewal: a grant for the same (realm, peer, role) replaces the earlier one whole, whatever its serial, so a new
   * credential with a later `notAfter` extends access and scopes it no longer carries are gone. The caller (the realm
   * layer) decides which credential is newer; the registry does not order serials. A grant that ends up with no scope
   * removes what it replaces.
   *
   * @param {object} grant
   * @param {string} grant.realmId
   * @param {string|number} grant.serial - The credential's serial
   * @param {string} grant.peerKey - The peer's key, proven on the link
   * @param {string} grant.role
   * @param {string[]} grant.scopes - What the credential's role carries
   * @param {number} grant.notAfter - Expiry, ms epoch on the registry's clock (a credential's seconds times 1000)
   * @param {number} grant.epoch - The realm epoch the credential was issued under
   * @returns {{ granted: string[], dropped: { scope: string|null, reason: string }[] }}
   */
  grantRealmScopes({ realmId, serial, peerKey, role, scopes, notAfter, epoch } = {}) {
    const fail = (what) => { throw new TypeError(`PeerRegistry.grantRealmScopes: ${what}`) }
    if (typeof realmId !== 'string' || realmId === '') fail('realmId is a non-empty string')
    if (typeof serial !== 'string' && typeof serial !== 'number') fail('serial is a string or a number')
    if (typeof peerKey !== 'string' || peerKey === '') fail('peerKey is a non-empty string')
    if (typeof role !== 'string' || role === '') fail('role is a non-empty string')
    if (!Array.isArray(scopes)) fail('scopes is an array')
    if (typeof notAfter !== 'number' || !Number.isFinite(notAfter)) fail('notAfter is a finite number (ms epoch)')
    if (!Number.isInteger(epoch) || epoch < 0) fail('epoch is a non-negative integer')
    for (const scope of scopes) {
      const why = realmScopeRefusal(scope)
      if (why) fail(`${JSON.stringify(scope)} is not a scope a realm may grant (${why})`)
    }

    const drop = (scope, reason, into) => {
      into.push({ scope, reason })
      this.#onLog(2, `PeerRegistry: realm ${realmId} role ${role}: dropped ${scope ?? 'the whole grant'} for ${peerKey} (${reason})`)
      try {
        this.#onRealmGrantDropped({ realmId, serial, peerKey, role, scope, reason })
      } catch (err) {
        this.#onLog(1, `PeerRegistry: onRealmGrantDropped threw: ${err?.message || err}`)
      }
    }

    const dropped = []
    const granted = []
    const roles = this.#realmPolicy.get(realmId)
    const allow = roles?.get(role)
    if (!roles) drop(null, 'realm-not-honoured', dropped)
    else if (!allow) drop(null, 'role-not-allowed', dropped)
    else {
      for (const scope of [...new Set(scopes)]) {
        const verdict = realmAdmits(allow, scope)
        if (verdict === 'ok') granted.push(scope)
        else drop(scope, verdict, dropped)
      }
    }
    if (notAfter <= this.#clock.now()) return { granted: [], dropped } // already over: nothing to hold

    const slot = `${realmId}\u0000${role}`
    let held = this.#realmGrants.get(peerKey)
    const had = held?.has(slot) ?? false
    if (granted.length === 0) {
      if (had) {
        held.delete(slot)
        if (held.size === 0) this.#realmGrants.delete(peerKey)
        this.#scheduleExpiry()
        this.#emitAccessChange(peerKey, 'realm-revoked')
      }
      return { granted, dropped }
    }
    if (!held) {
      held = new Map()
      this.#realmGrants.set(peerKey, held)
    }
    held.set(slot, { realmId, serial, peerKey, role, scopes: granted, notAfter, epoch })
    if (this.#realmNextExpiry === null || notAfter < this.#realmNextExpiry) this.#realmNextExpiry = notAfter
    this.#scheduleExpiry()
    this.#onLog(3, `PeerRegistry: realm ${realmId} granted ${granted.join(', ')} to ${peerKey} until ${notAfter}`)
    this.#emitAccessChange(peerKey, had ? 'realm-replaced' : 'realm-granted')
    return { granted, dropped }
  }

  /**
   * Remove realm grants. `realmId` is required, and at least one of `peerKey`, `serial` and `belowEpoch`; those given
   * all have to match. `{ realmId, peerKey }` removes a peer's grants in that realm, `{ realmId, serial }` one
   * credential's, `{ realmId, belowEpoch: N }` everything issued under an epoch lower than N (a realm's epoch bump).
   * Announces an access change (`realm-revoked`) once for each peer that lost a grant. Never touches the operator's
   * grants.
   *
   * @param {object} selector
   * @param {string} selector.realmId
   * @param {string} [selector.peerKey]
   * @param {string|number} [selector.serial]
   * @param {number} [selector.belowEpoch]
   * @returns {number} How many grants were removed
   */
  revokeRealmGrants({ realmId, peerKey, serial, belowEpoch } = {}) {
    if (typeof realmId !== 'string' || realmId === '') throw new TypeError('PeerRegistry.revokeRealmGrants: realmId is a non-empty string')
    if (peerKey === undefined && serial === undefined && belowEpoch === undefined) {
      throw new TypeError('PeerRegistry.revokeRealmGrants: name peerKey, serial or belowEpoch as well as the realm')
    }
    if (belowEpoch !== undefined && typeof belowEpoch !== 'number') throw new TypeError('PeerRegistry.revokeRealmGrants: belowEpoch is a number')
    const peers = peerKey === undefined ? [...this.#realmGrants.keys()] : [peerKey]
    const affected = []
    let removed = 0
    for (const key of peers) {
      const held = this.#realmGrants.get(key)
      if (!held) continue
      let lost = false
      for (const [slot, grant] of held) {
        if (grant.realmId !== realmId) continue
        if (serial !== undefined && grant.serial !== serial) continue
        if (belowEpoch !== undefined && !(grant.epoch < belowEpoch)) continue
        held.delete(slot)
        removed += 1
        lost = true
      }
      if (held.size === 0) this.#realmGrants.delete(key)
      if (lost) affected.push(key)
    }
    if (removed > 0) {
      this.#scheduleExpiry()
      this.#onLog(3, `PeerRegistry: removed ${removed} realm grant(s) of ${realmId}`)
      for (const key of affected) this.#emitAccessChange(key, 'realm-revoked')
    }
    return removed
  }

  /**
   * The live realm grants, for inspection (copies; an expired grant is not listed).
   *
   * @param {object} [filter]
   * @param {string} [filter.realmId]
   * @param {string} [filter.peerKey]
   * @returns {{ realmId: string, serial: string|number, peerKey: string, role: string, scopes: string[], notAfter: number, epoch: number }[]}
   */
  listRealmGrants({ realmId, peerKey } = {}) {
    const now = this.#clock.now()
    const out = []
    for (const [key, held] of this.#realmGrants) {
      if (peerKey !== undefined && key !== peerKey) continue
      for (const grant of held.values()) {
        if (realmId !== undefined && grant.realmId !== realmId) continue
        if (grant.notAfter <= now) continue
        out.push({ ...grant, scopes: [...grant.scopes] })
      }
    }
    return out
  }

  // ── Trust management ────────────────────────────────────────────────

  /**
   * Set the trust level for a peer (from the local pod's perspective).
   *
   * @param {string} pubKey
   * @param {number} level - Trust in [0.0, 1.0]
   * @param {string[]} [scopes] - Scope tags for the trust relationship
   */
  setTrust(pubKey, level, scopes) {
    this.#trustGraph.addEdge(this.#localPodId, pubKey, level, scopes)
    this.#onLog(3, `PeerRegistry: set trust ${level} for ${pubKey}`)
  }

  /**
   * Get the trust level we have for a peer (direct or transitive).
   *
   * @param {string} pubKey
   * @returns {number} Trust in [0.0, 1.0]
   */
  getTrust(pubKey) {
    return this.#trustGraph.getTrustLevel(this.#localPodId, pubKey)
  }

  /**
   * Record a runtime-observed trust/reputation signal without overwriting
   * the operator's explicit trust graph input.
   *
   * @param {string} pubKey
   * @param {number} level
   * @returns {number}
   */
  recordObservedTrust(pubKey, level) {
    const clamped = Math.max(0, Math.min(1, Number(level) || 0))
    this.#observedTrust.set(pubKey, clamped)
    this.#onLog(3, `PeerRegistry: observed trust ${clamped} for ${pubKey}`)
    return clamped
  }

  /**
   * @param {string} pubKey
   * @returns {number}
   */
  getObservedTrust(pubKey) {
    return this.#observedTrust.get(pubKey) ?? 0
  }

  /**
   * Combined reputation score used for route ranking. Explicit trust remains
   * authoritative, with observed runtime quality blended in as a secondary
   * signal.
   *
   * @param {string} pubKey
   * @returns {number}
   */
  getReputation(pubKey) {
    const explicit = this.getTrust(pubKey)
    const observed = this.getObservedTrust(pubKey)
    return explicit > 0
      ? Math.max(0, Math.min(1, explicit * 0.7 + observed * 0.3))
      : observed
  }

  /**
   * Check whether a peer is trusted, optionally within a scope.
   *
   * @param {string} pubKey
   * @param {string|null} [scope]
   * @param {number} [minLevel=0.25]
   * @returns {boolean}
   */
  isTrusted(pubKey, scope, minLevel) {
    return this.#trustGraph.isTrusted(this.#localPodId, pubKey, scope, minLevel)
  }

  // ── Connection lifecycle ────────────────────────────────────────────

  /**
   * Connect to a peer (delegates to MeshPeerManager).
   *
   * @param {string} pubKey
   * @param {object} [opts]
   * @param {string} [opts.transport]
   * @param {string} [opts.endpoint]
   * @returns {import('@johnhenry/browsermesh-core').PeerState}
   */
  connect(pubKey, opts) {
    return this.#peerManager.connect(pubKey, opts)
  }

  /**
   * Disconnect a peer.
   *
   * @param {string} pubKey
   */
  disconnect(pubKey) {
    this.#peerManager.disconnect(pubKey)
  }

  /**
   * Disconnect all peers.
   */
  disconnectAll() {
    this.#peerManager.disconnectAll()
  }

  // ── Access-change events ────────────────────────────────────────────

  /**
   * Subscribe to changes that can reduce what a peer is allowed to do:
   * `revokeCapabilities()`, `removePeer()`, `updatePermissions()`,
   * `notifyAccessChange()` and the realm grant source (`kind` `realm-granted`,
   * `realm-replaced`, `realm-revoked`, `realm-policy`, and `expired` when a
   * grant runs out). Long-lived users of `checkAccess()` (relayed
   * connections, for example) re-check on this event instead of on every use.
   *
   * @param {(event: { pubKey: string, kind: string }) => void} cb
   * @returns {() => void} unsubscribe
   */
  onAccessChange(cb) {
    if (typeof cb !== 'function') return () => {}
    this.#accessListeners.add(cb)
    return () => this.#accessListeners.delete(cb)
  }

  /**
   * Announce that a peer's access may have changed through a path this class
   * did not see (for example a direct change to the injected ACL).
   *
   * @param {string} pubKey
   */
  notifyAccessChange(pubKey) {
    this.#emitAccessChange(pubKey, 'changed')
  }

  /**
   * Keep exactly one timer armed for the nearest expiry among the grants this registry issued, so that a
   * grant that runs out is announced (`kind: 'expired'`) like one that is revoked. There is one timer for
   * the registry, however many grants it holds; an expiry further away than a timer can wait is reached in steps.
   */
  #scheduleExpiry() {
    let next = null
    for (const tokens of this.#capabilityTokens.values()) {
      for (const token of tokens.values()) {
        if (token.revoked || this.#announcedExpiry.has(token)) continue
        const at = token.expiresAt
        if (typeof at !== 'number' || !Number.isFinite(at)) continue
        if (next === null || at < next) next = at
      }
    }
    if (this.#realmGrants.size === 0) this.#realmNextExpiry = null
    else if (this.#realmNextExpiry !== null && (next === null || this.#realmNextExpiry < next)) next = this.#realmNextExpiry
    if (next === this.#expiryAt && (next === null || this.#expiryTimer !== null)) return
    if (this.#expiryTimer !== null) {
      this.#clock.clearTimeout(this.#expiryTimer)
      this.#expiryTimer = null
    }
    this.#expiryAt = next
    if (next === null) return
    const delay = Math.min(Math.max(next - this.#clock.now(), 0), MAX_TIMER_DELAY_MS)
    const handle = this.#clock.setTimeout(() => this.#onExpiryTimer(), delay)
    handle?.unref?.() // a pending expiry must not keep a process alive
    this.#expiryTimer = handle
  }

  #onExpiryTimer() {
    this.#expiryTimer = null
    this.#expiryAt = null
    const now = this.#clock.now()
    const expired = new Set()
    for (const [pubKey, tokens] of this.#capabilityTokens) {
      for (const token of tokens.values()) {
        if (token.revoked || this.#announcedExpiry.has(token)) continue
        if (typeof token.expiresAt === 'number' && token.expiresAt <= now) {
          this.#announcedExpiry.add(token)
          expired.add(pubKey)
        }
      }
    }
    // Realm grants: drop the ones that are over and take the exact nearest of the rest.
    let realmNext = null
    for (const [pubKey, held] of this.#realmGrants) {
      for (const [slot, grant] of held) {
        if (grant.notAfter <= now) {
          held.delete(slot)
          expired.add(pubKey)
        } else if (realmNext === null || grant.notAfter < realmNext) realmNext = grant.notAfter
      }
      if (held.size === 0) this.#realmGrants.delete(pubKey)
    }
    this.#realmNextExpiry = realmNext
    // Re-arm first: a listener that grants again must find the timer in a consistent state.
    this.#scheduleExpiry()
    for (const pubKey of expired) this.#emitAccessChange(pubKey, 'expired')
  }

  /** Release the expiry timer and drop the access-change listeners. */
  dispose() {
    if (this.#expiryTimer !== null) this.#clock.clearTimeout(this.#expiryTimer)
    this.#expiryTimer = null
    this.#expiryAt = null
    this.#accessListeners.clear()
  }

  /** @param {string} pubKey @param {string} kind */
  #emitAccessChange(pubKey, kind) {
    for (const cb of [...this.#accessListeners]) {
      try { cb({ pubKey, kind }) } catch (err) {
        this.#onLog(1, `PeerRegistry: access-change listener threw: ${err?.message || err}`)
      }
    }
  }

  // ── Events ──────────────────────────────────────────────────────────

  /**
   * Register a callback for peer connection events.
   * @param {Function} cb
   */
  onPeerConnect(cb) {
    this.#peerManager.onPeerConnect(cb)
  }

  /**
   * Register a callback for peer disconnection events.
   * @param {Function} cb
   */
  onPeerDisconnect(cb) {
    this.#peerManager.onPeerDisconnect(cb)
  }

  // ── Stats ───────────────────────────────────────────────────────────

  /**
   * Get aggregate connection statistics.
   *
   * @returns {{ total: number, connected: number, disconnected: number, connecting: number }}
   */
  getStats() {
    return this.#peerManager.getStats()
  }

  /** @returns {number} */
  get size() {
    return this.#peerManager.size
  }

  // ── Persistence ─────────────────────────────────────────────────────

  /**
   * Serialize the full registry state.
   *
   * @returns {object}
   */
  toJSON() {
    return {
      localPodId: this.#localPodId,
      peers: this.#peerManager.toJSON(),
      trust: this.#trustGraph.toJSON(),
      observedTrust: Object.fromEntries(this.#observedTrust),
      acl: this.#acl.toJSON(),
    }
  }

  /**
   * Restore a PeerRegistry from serialized data.
   * Requires the same subsystem constructors to be available; accepts
   * factory functions for creating typed instances from JSON.
   *
   * @param {object} data
   * @param {object} [factories] - Optional constructors for subsystems
   * @param {Function} [factories.PeerManager] - MeshPeerManager class
   * @param {Function} [factories.TrustGraph] - TrustGraph class
   * @param {Function} [factories.ACL] - MeshACL class
   * @returns {PeerRegistry}
   */
  static fromJSON(data, factories = {}) {
    const PeerManager = factories.PeerManager
    const Trust = factories.TrustGraph
    const ACL = factories.ACL

    const peerManager = PeerManager ? PeerManager.fromJSON(data.peers) : undefined
    const trustGraph = Trust ? Trust.fromJSON(data.trust) : undefined
    const acl = ACL ? ACL.fromJSON(data.acl) : undefined

    const registry = new PeerRegistry({
      localPodId: data.localPodId,
      peerManager,
      trustGraph,
      acl,
    })
    for (const [pubKey, level] of Object.entries(data.observedTrust || {})) {
      registry.#observedTrust.set(pubKey, level)
    }
    return registry
  }

  // ── Internal helpers ────────────────────────────────────────────────

  /**
   * Create a minimal duck-typed MeshPeerManager when none is injected.
   * @returns {object}
   */
  #createDefaultPeerManager() {
    const peers = new Map()
    const callbacks = { connect: [], disconnect: [] }

    const fire = (event, data) => {
      for (const cb of [...(callbacks[event] || [])]) {
        try { cb(data) } catch (e) { silentCatch('peer-registry', 'swallow', e) }
      }
    }

    return {
      addPeer(fingerprint, info = {}) {
        const existing = peers.get(fingerprint)
        if (existing) {
          Object.assign(existing, info)
          return existing
        }
        const peer = { fingerprint, status: 'disconnected', ...info }
        peers.set(fingerprint, peer)
        return peer
      },
      removePeer(fingerprint) { return peers.delete(fingerprint) },
      getPeer(fingerprint) { return peers.get(fingerprint) || null },
      listPeers(filter = {}) {
        let list = [...peers.values()]
        if (filter.status) list = list.filter(p => p.status === filter.status)
        if (filter.minTrust !== undefined) list = list.filter(p => (p.trustLevel || 0) >= filter.minTrust)
        return list
      },
      connect(fingerprint, opts = {}) {
        if (!peers.has(fingerprint)) this.addPeer(fingerprint, opts)
        const peer = peers.get(fingerprint)
        const oldStatus = peer.status
        peer.status = 'connected'
        peer.transport = opts.transport || null
        peer.endpoint = opts.endpoint || null
        if (oldStatus !== 'connected' && oldStatus !== 'authenticated') fire('connect', peer)
        return peer
      },
      disconnect(fingerprint) {
        const peer = peers.get(fingerprint)
        if (!peer) return
        const old = peer.status
        peer.status = 'disconnected'
        peer.transport = null
        if (old !== 'disconnected') fire('disconnect', peer)
      },
      disconnectAll() { for (const fp of peers.keys()) this.disconnect(fp) },
      onPeerConnect(cb) { callbacks.connect.push(cb) },
      onPeerDisconnect(cb) { callbacks.disconnect.push(cb) },
      offPeerConnect(cb) {
        const idx = callbacks.connect.indexOf(cb)
        if (idx >= 0) callbacks.connect.splice(idx, 1)
      },
      offPeerDisconnect(cb) {
        const idx = callbacks.disconnect.indexOf(cb)
        if (idx >= 0) callbacks.disconnect.splice(idx, 1)
      },
      clearListeners() { callbacks.connect.length = 0; callbacks.disconnect.length = 0 },
      getStats() {
        const all = [...peers.values()]
        return {
          total: all.length,
          connected: all.filter(p => p.status === 'connected' || p.status === 'authenticated').length,
          disconnected: all.filter(p => p.status === 'disconnected').length,
          connecting: all.filter(p => p.status === 'connecting').length,
        }
      },
      get size() { return peers.size },
      toJSON() { return [...peers.values()] },
    }
  }

  /**
   * Create a minimal duck-typed TrustGraph when none is injected.
   * @returns {object}
   */
  #createDefaultTrustGraph() {
    const edges = []

    return {
      addEdge(fromId, toId, level, scopes = []) {
        const idx = edges.findIndex(e => e.from === fromId && e.to === toId)
        if (idx >= 0) edges.splice(idx, 1)
        edges.push({ from: fromId, to: toId, value: level, scopes: [...scopes] })
      },
      removeEdge(fromId, toId) {
        const idx = edges.findIndex(e => e.from === fromId && e.to === toId)
        if (idx >= 0) { edges.splice(idx, 1); return true }
        return false
      },
      getTrustLevel(fromId, toId) {
        const e = edges.find(e => e.from === fromId && e.to === toId)
        return e ? e.value : 0
      },
      isTrusted(fromId, toId, scope, minLevel = 0.25) {
        const e = edges.find(e => e.from === fromId && e.to === toId)
        if (!e || e.value < minLevel) return false
        if (scope && e.scopes.length > 0 && !e.scopes.includes(scope)) return false
        return true
      },
      toJSON() { return edges.map(e => ({ ...e, scopes: [...e.scopes] })) },
    }
  }

  /**
   * Create a minimal duck-typed MeshACL when none is injected.
   * @returns {object}
   */
  #createDefaultACL() {
    const owner = this.#localPodId
    const templates = new Map()
    const roster = new Map()

    // Seed default templates
    templates.set('guest', { name: 'guest', scopes: ['chat:read', 'files:read'] })
    templates.set('collaborator', { name: 'collaborator', scopes: ['chat:*', 'files:read', 'files:write', 'compute:submit'] })
    templates.set('admin', { name: 'admin', scopes: ['*:*'] })

    // The same matcher `MeshACL` uses (segment by segment, any number of segments).
    return {
      addTemplate(name, scopes, description) {
        const t = { name, scopes: [...scopes], description }
        templates.set(name, t)
        return t
      },
      removeTemplate(name) { return templates.delete(name) },
      getTemplate(name) { return templates.get(name) || null },
      addEntry(identity, templateName, opts = {}) {
        if (!templates.has(templateName)) throw new Error(`Unknown template: ${templateName}`)
        const entry = { identity, templateName, ...opts }
        roster.set(identity, entry)
        return entry
      },
      removeEntry(identity) { return roster.delete(identity) },
      getEntry(identity) { return roster.get(identity) || null },
      check(identity, resource, action) {
        if (identity === owner) return { allowed: true, reason: 'owner' }
        const entry = roster.get(identity)
        if (!entry) return { allowed: false, reason: 'not_in_roster' }
        const tpl = templates.get(entry.templateName)
        if (!tpl) return { allowed: false, reason: 'template_missing' }
        const scope = `${resource}:${action}`
        if (tpl.scopes.some(s => matchScope(s, scope))) return { allowed: true }
        return { allowed: false, reason: 'scope_denied' }
      },
      revokeAll(identity) {
        const had = roster.has(identity)
        roster.delete(identity)
        return had ? 1 : 0
      },
      toJSON() {
        return {
          owner,
          templates: [...templates.values()].filter(t => !['guest', 'collaborator', 'admin'].includes(t.name)),
          roster: [...roster.values()],
        }
      },
    }
  }

  /**
   * Create a minimal duck-typed CapabilityValidator when none is injected.
   * Mirrors the subset of `@johnhenry/browsermesh-core`'s real
   * `CapabilityValidator` that `grantCapabilities()`/`revokeCapabilities()`/
   * `checkAccess()` actually use: `register()`, `revokeTree()` (revokes a
   * token and, transitively, any tracked token whose `parentId` chains up to
   * it -- unused by this class today since tokens here are always
   * root/flat, but kept for parity with the real class and any future
   * attenuation use), and `validate()` for completeness/introspection.
   * @returns {object}
   */
  #createDefaultCapabilityValidator() {
    const tokens = new Map()
    const revokedIds = new Set()

    const validator = {
      register(token) {
        tokens.set(token.id, token)
        if (token.revoked) revokedIds.add(token.id)
      },
      revokeTree(tokenId) {
        revokedIds.add(tokenId)
        const token = tokens.get(tokenId)
        if (token) token.revoke()
        for (const [id, t] of tokens) {
          if (t.parentId === tokenId && !revokedIds.has(id)) {
            validator.revokeTree(id)
          }
        }
      },
      validate(tokenId, resource, permission) {
        const token = tokens.get(tokenId)
        if (!token) return { allowed: false, reason: 'Token not found' }
        if (revokedIds.has(tokenId)) return { allowed: false, reason: 'Token revoked' }
        if (token.isExpired()) return { allowed: false, reason: 'Token expired' }
        if (!token.hasPermission(permission)) {
          return { allowed: false, reason: `Permission "${permission}" not granted` }
        }
        const pattern = token.resource
        const matches = pattern === resource || pattern === '*' ||
          (pattern.endsWith('*') && resource.startsWith(pattern.slice(0, -1)))
        if (!matches) {
          return { allowed: false, reason: `Resource "${resource}" not covered by "${pattern}"` }
        }
        return { allowed: true }
      },
      get size() { return tokens.size },
      listTokens() { return [...tokens.values()] },
    }
    return validator
  }
}
