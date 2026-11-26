---
"@johnhenry/browsermesh-apps": patch
---

A peer that starts over is now recognised on a connection this node still holds even when that connection is no longer open. The negotiator told the node `restarted` only when the fresh offer found the connection open; a peer that went away without a close this side had seen yet (its channel closing, or its state failed) left a connection that was held and handed to the node but not open, so the offer swapped the connection underneath, nothing ever reported the old one closed, and the channel link that ran over it stayed up for a node that remembers nothing of it. A connection is now held when it is open or was handed to the node and has not closed since. A renegotiation (an ICE restart, whose answer says so) keeps the channel and what runs over it, and is no longer reported as a restart. Nothing is added to the wire and no option or default changes: an older peer is served as before.
