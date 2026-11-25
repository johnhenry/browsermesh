---
'@johnhenry/browsermesh-primitives': minor
---

Share codes that name the key that made them: `generateShareCode` (12 characters, 60 bits), `shareFingerprintOfPodId` /
`shareFingerprintOfPublicKey` (the first 140 bits of the pod id, 28 base32 characters, no second hash),
`podIdMatchesShareFingerprint` / `publicKeyMatchesShareFingerprint` (all 140 bits compared), `formatShare`, `parseShareInput`,
`normalizeShareCode`, `normalizeShareFingerprint` and the grouping helpers. `parseShareInput` reads the full code or a
`?join=` link, tolerates case, spacing and I/L/O typos, never throws, and refuses the short half alone with a message that
says to ask for the full share code or the link. `sanitizeLabel` cleans text a peer controls (escape sequences, control,
bidi and zero-width characters, length). Pure functions, called by nothing in the package: existing behaviour and the wire are
unchanged.
