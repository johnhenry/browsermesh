---
"@johnhenry/browsermesh-ingress": minor
---

New `listenNode` option `halfClosedClients` (off by default; nothing existing changes). With it, a client that has sent its whole request and then finished sending (`nc -N`, `shutdown(SHUT_WR)`) is answered: the connection stays open for the answer and ends after the response, bounded by `limits.timeoutMs`. Without it, as before, Node's HTTP server treats the client's end of file as a hang-up and an answer that is not ready is lost. It is off because a client's end of file is also all that Firefox and WebKit send when a fetch is aborted, and with the option on that no longer aborts the page's handler until `limits.timeoutMs`.
