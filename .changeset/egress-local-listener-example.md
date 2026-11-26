---
"@johnhenry/browsermesh-egress": patch
---

The README no longer lists "an adapter example" as not built: `examples/local-listener.mjs` (in the repository) is a Node consumer that listens on a loopback port and carries each connection through `connectEgress` to a granted destination, with a grants file for the `browsermesh-egress` command. Documentation only; nothing in the package's code changed.
