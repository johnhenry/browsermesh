---
'@johnhenry/browsermesh-transport': minor
---

With an `identity`, every WebRTC offer and answer (renegotiations included) now carries `auth`, a signature made with the
pod key over the kind, both pod ids, the exact description text and its DTLS fingerprints (an answer also covers the offer
it answers). A description that arrives with `auth` is verified against the peer's key before it is applied; one that does
not verify makes `handleOffer()` / `handleAnswer()` throw and leaves the connection untouched (`descriptionFailure`,
`descriptionVerified`). New exports `signDescription`, `verifyDescription`, `descriptionTranscript`; new option
`requireSignedDescription` (default off: an unsigned description from an older peer is still applied, and the proof on the
connection still binds it). The only wire addition is the extra `auth` field, which an older peer ignores.
