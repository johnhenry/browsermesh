---
"@johnhenry/browsermesh-apps": patch
---

The optional peer range on `@johnhenry/browsermesh-transport` is now `>=0.13.1 <1.0.0` (was `>=0.6.0 <1.0.0`): 0.13.1 is the first transport that passes `authorize(peer, { restricted: true })`, which link admission over wsh needs. The fail-closed negotiation in `createWshAdmissionAuthorize` stays for a transport outside the range.
