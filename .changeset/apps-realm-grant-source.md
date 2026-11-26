---
"@johnhenry/browsermesh-apps": minor
---

`PeerRegistry` gains a realm grant source, a prerequisite for realms (`docs/design/realms.md`).

- **A separate source, not the operator's slot.** `grantRealmScopes({ realmId, serial, peerKey, role, scopes, notAfter, epoch })`, `revokeRealmGrants({ realmId, peerKey | serial | belowEpoch })`, `listRealmGrants()` and `setRealmPolicy()`. `checkAccess()` allows if the operator's grants allow or a live realm grant covers the scope, so a realm's renewal, expiry or revocation can no longer extend, shorten, poison or delete a grant the operator made. Realm grants are keyed by (realm, role, peer), carry their own expiry and epoch, and are never written by `toJSON()` nor restored by `fromJSON()`.
- **Host policy decides.** New `realmPolicy` and `onRealmGrantDropped` constructor options. The default honours no realm, so nothing changes for existing users. A role scope outside the host's allow list is dropped and reported; `egress:`, `ingress:`, `pod-host` and `wsh-` scopes are granted only if a pattern in the allow list begins that way; a wildcard or short scope is refused.
- **Events.** Added, replaced, removed and expired realm grants announce through `onAccessChange` (`realm-granted`, `realm-replaced`, `realm-revoked`, `realm-policy`, `expired`), and expiry shares the registry's one timer.
