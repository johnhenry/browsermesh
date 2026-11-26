---
"@johnhenry/browsermesh-objects": patch
"@johnhenry/browsermesh-mcp": patch
"@johnhenry/browsermesh-transport": patch
"@johnhenry/browsermesh-egress": patch
---

The READMEs now say these packages are tested against `@johnhenry/wsh` up to 0.57.0. Nothing in the code of these four changed and every peer range is unchanged: none needs the half-close rule that 0.57 added. The egress package gained tests for a consumer that finishes sending and keeps reading (an answer two seconds later, a large one, a destination that finishes first, both sides finishing, a silent half-closed consumer ended by `idleMs`), and its README says what bounds a half-closed connection; the transport's wsh link ends when it reads the peer's end of stream, and a test now pins that.
