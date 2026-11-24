---
"@johnhenry/browsermesh-apps": patch
"@johnhenry/browsermesh-core": patch
"@johnhenry/browsermesh-discovery": patch
"@johnhenry/browsermesh-embed": patch
"@johnhenry/browsermesh-kernel": patch
"@johnhenry/browsermesh-pod": patch
"@johnhenry/browsermesh-sync": patch
"@johnhenry/browsermesh-transport": patch
---

File headers, comments, log tags, READMEs and examples no longer carry the name of the private monorepo this code was extracted from. No behaviour change, with these naming additions: `BrowsermeshEmbed` is the primary export of `@johnhenry/browsermesh-embed` and `ClawserEmbed` stays as a deprecated alias; the debug switch is now the `browsermesh_debug` localStorage key and the `[browsermesh:silent-catch]` console prefix, and the old `clawser_debug` key still works as a deprecated alias.
