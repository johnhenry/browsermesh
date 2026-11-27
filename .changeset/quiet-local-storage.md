---
"@johnhenry/browsermesh-apps": patch
"@johnhenry/browsermesh-core": patch
"@johnhenry/browsermesh-sync": patch
"@johnhenry/browsermesh-transport": patch
---

Importing the package no longer prints Node's "ExperimentalWarning: localStorage is not available because --localstorage-file was not provided" on stderr. The debug-flag reader now inspects the `localStorage` property descriptor first and only calls Node's getter when `--localstorage-file` is set (or in a browser); data-property polyfills are still honoured.
