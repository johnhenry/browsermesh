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

**Revert condition.** When `node-datachannel` ships a release built against
libdatachannel >= v0.24.5:

1. Bump `node-datachannel` in `packages/browsermesh-transport/package.json`.
2. Delete both retries and their comments.
3. Re-run `npm run test:real-peer` at least 24 times and confirm 0 failures.
   Check *durations*, not just exit codes: before the retries the
   malformed-candidate test failed 3/24 on a 15s timeout; with them it passes
   in 277ms normally and 5.5s when the retry fires. A green run alone does not
   distinguish "fixed" from "got lucky".
4. Close #26.

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
