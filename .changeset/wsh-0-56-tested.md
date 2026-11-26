---
"@johnhenry/browsermesh-objects": patch
"@johnhenry/browsermesh-mcp": patch
"@johnhenry/browsermesh-transport": patch
---

The READMEs now say these packages are tested against `@johnhenry/wsh` up to 0.56.1. Nothing in the code changed and every peer range is unchanged: none of these packages uses a wsh forward, so nothing here needs what 0.56 added.
