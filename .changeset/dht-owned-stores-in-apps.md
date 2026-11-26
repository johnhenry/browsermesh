---
"@johnhenry/browsermesh-discovery": minor
"@johnhenry/browsermesh-apps": minor
---

The DHT that `createMeshNode({ enableDht })` runs can now store under the pod's own key and check what it is sent, both opt-in.

- **discovery:** `DhtDiscoveryStrategy` takes `storePolicy` (handed to its `DhtNode`), `now`, `signStore(key, record)` (called by `announce` to sign the record it stores; a signer that throws stores nothing) and `onStoreRefused`; `strategy.storePolicy` and `dhtNode.storePolicy` report what is in force. With none of them the strategy is what it was.
- **apps:** `createMeshNode({ enableDht, dhtSignStores, dhtStorePolicy, dhtStoreLifetimeMs })` and `createMeshDht({ signStores, identity, storePolicy, storeLifetimeMs })`. `dhtSignStores` signs the record the node announces with the pod's key (a `seq` that rises with every announce, an expiry 24 h ahead by default); `dhtStorePolicy: 'open' | 'owned'` makes this node check the stores it receives (`'owned'` holds only records that carry a valid proof, and needs `dhtSignStores`). Off by default. A node that does not check ignores the proof, so signing is safe in a mixed swarm; an `'owned'` node does not hold a record from a node that does not sign. With an older discovery package that ignores these options, `createMeshDht` throws instead of quietly storing unsigned.
