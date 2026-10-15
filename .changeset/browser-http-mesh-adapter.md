---
"@johnhenry/browsermesh-primitives": patch
"@johnhenry/browsermesh-discovery": patch
"@johnhenry/browsermesh-apps": minor
---

Share browser-safe mesh address parsing through primitives and discovery, retaining case-sensitive IDs and query strings. Remove the Node-only mesh-fetch factory path. Add explicit HTTP body mode and Request input with bounded byte-preserving uploads, native multipart headers, cancellation and correct HEAD/bodyless responses, while retaining the default structured JSON-body convention. HTTP bodies are buffered, not streamed.
