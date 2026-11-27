---
'@johnhenry/browsermesh-ingress': patch
---

The Node listener's `501 Not Implemented` for a method token Node's HTTP parser does not know now has a body (and the reason `method-not-implemented`) that lists the methods the listener carries (`http.METHODS`) and says the programmatic `handle()` carries any RFC 9110 method token. The standard set is the decided scope of the listener; the README's failure table and `docs/security.md` list the case (#471).
