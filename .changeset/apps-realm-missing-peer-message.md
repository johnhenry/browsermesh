---
'@johnhenry/browsermesh-apps': patch
---

The error `createMeshNode({ realm })` throws when `@johnhenry/browsermesh-realm` is not installed now says to install it (an optional peer dependency), instead of calling it a private, unpublished workspace package. The package is on npm.
