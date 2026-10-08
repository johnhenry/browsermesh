---
"@johnhenry/browsermesh-core": patch
"@johnhenry/browsermesh-transport": patch
---

Raise the `@johnhenry/browsermesh-primitives` peer range to `>=0.3.0 <1.0.0` and import `padTo` and `unpad` by name, now that primitives 0.3.0 is published (#231). Padding no longer needs a runtime check for an old primitives.
