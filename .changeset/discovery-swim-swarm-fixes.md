---
'@johnhenry/browsermesh-discovery': minor
---

Fix three bugs (#434). Minor, because `SwimMembership` gains options (`maxPiggyback`, `retransmitMultiplier`, `maxQueuedUpdates`), `SwarmCoordinator` gains `stop()`, and the gossip behaviour changes.

- `SwimMembership` now disseminates updates SWIM-style: each update rides up to `ceil(retransmitMultiplier * ceil(log2(n + 1)))` messages (default multiplier 3), least-transmitted first, at most `maxPiggyback` (default 8) per message, then is retired; updates a pod learns are passed on, and a message from an unknown peer introduces it. Seeds in a chain now converge. The wire format and the precedence rules are unchanged.
- `SwarmCoordinator` (given `swim`) now drops a member on SWIM `left` as well as `dead`, brings it back on a higher-incarnation `alive`, chains callbacks already set on the SWIM instance, and has `stop()` to unhook.
- Importing the package no longer prints Node's `ExperimentalWarning` about `localStorage`.
