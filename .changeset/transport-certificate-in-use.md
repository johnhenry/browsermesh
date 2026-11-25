---
'@johnhenry/browsermesh-transport': minor
---

With an `identity`, a WebRTC connection now also compares the certificate it actually uses (read from
`RTCDtlsTransport.getRemoteCertificates()` or the `certificate` entry of `getStats()`) with the fingerprint the peer's own
session description named, before it is reported bound; a different certificate closes it (`bindingFailure`
`certificate-mismatch`). `certificateCheck` reports `matched`, `mismatch` or `unavailable` (the browser exposes nothing, so
nothing is claimed). New exports `remoteCertificateFingerprints` and `certificateMatches`; new options `checkCertificate`
(default on, only with `identity`) and `requireCertificateCheck` (default off). Nothing is sent, so an older peer is
unaffected.
