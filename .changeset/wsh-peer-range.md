---
'@johnhenry/browsermesh-transport': patch
---

The optional peer `@johnhenry/wsh` is `>=0.45.0 <1.0.0` instead of `^0.45.0` (#334).

For a 0.x version `^0.45.0` means 0.45 only, so any current wsh was a peer conflict. The wsh link tests (116) and the sealed link example were run against wsh 0.45.0, 0.46.0, 0.46.1, 0.47.0 and 0.48.0 and pass on each; nothing newer has been tried. No code changed.
