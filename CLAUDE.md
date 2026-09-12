# browsermesh — Project Guide for AI Assistants

Peer-to-peer mesh networking for browser environments. npm workspaces monorepo,
ten packages under `packages/`, Node >= 24, `node:test` throughout.

```bash
npm test               # turbo run test --concurrency=4, all workspaces
npm run test:real-peer # real WebRTC peers — serialised, see below
```

## Pending upstream revert — real-peer WebRTC retries

**Check this whenever you touch `packages/browsermesh-transport/test/real-peer/`.**

Two handshake retries in `test/real-peer/webrtc.test.mjs` — the loop inside
`connect()`, and the matching one in the malformed-candidate test — are a
workaround for a bug that is not ours. Both carry a delete-me comment.

libdatachannel's `DtlsTransport::doRecv()` wrote incoming DTLS records into the
input BIO without holding `mSslMutex`. A memory BIO clears its retry flags on
write, so `SSL_get_error()` running concurrently in `start()` saw
`SSL_want_read` with `BIO_should_read` false, fell through every branch, and
returned `SSL_ERROR_SYSCALL` — reported as `"fatal I/O error"` when no I/O error
occurred. Roughly 1 handshake in 130. Measured with an 800-trial C++
reproducer: v0.24.3 **6/800**, v0.24.5 **0/800**, master **0/800**.

Fixed upstream in libdatachannel v0.24.5 (`paullouisageneau/libdatachannel#1584`).
`node-datachannel` still pins `GIT_TAG "v0.24.3"`, the last release without it,
so we inherit the bug. `murat-dogan/node-datachannel#444` bumps the pin.

**Reverted on 2026-09-12 — the condition was met.** `node-datachannel` 0.33.4 is
the first release whose CMakeLists carries `GIT_TAG "v0.24.5"` AND whose nine
platform packages are all published at 0.33.4. Both halves were needed:
0.33.3 bumped the source pin while still depending on the 0.33.2 prebuilt
binaries (`murat-dogan/node-datachannel#445`), so the fix did not reach the
addon that loads.

Verified by content rather than by version number, and by what actually loads
rather than by what the install printed: the addon in `require.cache` resolves
to `@node-datachannel/darwin-arm64@0.33.4`.

Both retries are deleted. Measured after deleting them, 30 serialised runs on
an idle machine: **0/30 runs failed, 330/330 tests passed**, and the
malformed-candidate test ran in **273.5-279.2 ms** — a 5.7 ms spread across
thirty runs. That tightness is the evidence, not the green: the retry-fired
signature is ~5.5 s and the unfixed-without-retry signature is a 15 s timeout,
and neither appears anywhere in the distribution. A surviving flake would be
bimodal. If the old 3/24 per-run rate still held, thirty clean runs had a 1.8%
chance of happening.

**Do not try to pin `node-datachannel` to a source build.** This was tried and
it silently does nothing. The package ships prebuilt per-platform addons and has
no build-on-install step, so a git pin needs a `prepare` script — and npm 11's
`allow-scripts` gate blocks it. The install exits 0, no local build appears, and
the old prebuilt binary loads anyway. Verify any such attempt by checking what
`require.cache` actually holds, not by trusting the install.

## Testing notes

- **The real-peer suite is serialised on purpose, and that is unrelated to the
  retries above.** It stalls under machine load: 0/40 idle, 6/40 straight after
  a heavy run, and two of these suites running together failed 2 runs in 3.
  `turbo run test --concurrency=4` is exactly that loaded condition, which is
  why the suite is kept out of it and run on its own in CI. Keep the
  serialisation when the retries are eventually deleted.
- `REQUIRE_REAL_PEER=1` makes a missing `node-datachannel` binding fail rather
  than skip. CI sets it, because a skipped suite reports success.

## Releases

See `RELEASING.md`. Packages version independently; the root `package.json`
version is the release marker and releases are tagged `v<version>`.
