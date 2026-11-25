---
'@johnhenry/browsermesh-apps': minor
---

A held join for a peer registry, opt in: `createOfferingJoinGate({ registry })` and `createJoiningJoinGate({ install })`.
The offering side approves a request, the joining side keeps it, and nothing is added to the registry (or installed on the
joining side) until both have happened. An approval that is not kept runs out (default 5 minutes on both sides, with 10 s
more on the offering side for the message to arrive), so does a request nobody answers, and either side can leave at any
point. Waiting joins are bounded (`maxWaiting`, default 16). State machines with an injected clock: no UI and no wire
messages, and nothing else in the package uses them, so existing behaviour and older peers are unaffected.
