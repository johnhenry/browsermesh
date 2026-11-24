---
'@johnhenry/browsermesh-transport': minor
'@johnhenry/browsermesh-apps': patch
---

The transport's main entry no longer reaches wsh, so an application that does not use wsh can bundle or vendor it for a browser.

- The wsh peer links, services, relaying pod and pod transport (`WshPeerLinks`, `WshLink`, `WshLinkError`, `createWshTransportFactory`, `WshServices`, `WshRelay`, `WshPodTransport`, `connectWshServicesOverMesh`, `connectWshServicesViaRelay` and the rest of `wsh-links`, `wsh-services`, `wsh-relay`, `wsh-pod-transport`) now live at the new subpath `@johnhenry/browsermesh-transport/wsh`. The import graph of the main entry holds no `@johnhenry/wsh` specifier and no Node-only module; a test pins it, and the browser suite imports the entry in a page whose import map has no wsh.
- `TransportFactory.create('wsh', { links, peerPodId })` builds the link through `links.link(peerPodId)` instead of importing the link class.
- `./wsh-in-process` (the Node-only test relay) now has only a `node` export condition; a bundler for the browser cannot resolve it.
- `podIdToFingerprint`, `fingerprintToPodId` and `podIdFromRawKey` stay on the main entry (re-exported from primitives).
- The optional peer range for `@johnhenry/wsh` is now `*`, so a consumer that pins another wsh for its own reasons no longer gets a second, nested copy. The versions the features need (0.45 for links, 0.50 for services) are reported at use as a `WSH_UNAVAILABLE` error.

Nothing is removed for one release. What an existing importer must change: code that imports the names above from `@johnhenry/browsermesh-transport` keeps working wherever the `node` export condition applies (Node, a bundler built for Node) through a shim; anywhere else (a bundler or import map for the browser, a vendored copy of `src/`) import them from `@johnhenry/browsermesh-transport/wsh` now. The shim is removed in the next minor, so move those imports before then. Importing `@johnhenry/browsermesh-transport/wsh-in-process` from a browser build never worked in practice and is now refused at resolution.

`@johnhenry/browsermesh-apps` imports `WshPeerLinks` from the new subpath, falling back to the package root for a transport older than 0.11.
