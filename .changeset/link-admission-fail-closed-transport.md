---
"@johnhenry/browsermesh-transport": patch
---

`WshPeerLinks` calls `authorize(peer, { restricted: true })`: the second argument says the transport understands the `{ restricted: true }` verdict, so an authorizer can refuse instead of returning it to a transport that would grant a full link. New `WshPeerLinks.supportsRestrictedAdmission = true`. Existing authorizers ignore the extra argument.
