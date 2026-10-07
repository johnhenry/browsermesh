---
"@johnhenry/browsermesh-primitives": minor
---

Add `padTo()`, `unpad()`, `paddedLength()`, `DEFAULT_PAD_BUCKETS` and `PAD_TRAILER_BYTES`: opt-in size-bucket padding (default buckets 256/1024/4096/16384; oversize payloads round up to a multiple of the largest) so a relay that only sees ciphertext learns the bucket, not the exact payload length. Pad before sealing.
