// An in-memory duplex for the realm exchange: `link` is what the admission seam hands a handler (the verifier's side),
// `channel` is the prover's side. Frames cross asynchronously (setImmediate), like a real link, and every observable
// step is appended to one shared `log` so a test can assert ORDER (grant before result before promote).
export const settle = () => new Promise((r) => setImmediate(r));

export async function until(fn, ms = 3000, what = "condition") {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await settle();
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * @param {{ peerKey: string, proven?: boolean, text?: boolean, log?: string[] }} o
 *   `text: true` delivers the verifier's frames to the prover as JSON text (as wsh does), not as objects.
 */
export function wire({ peerKey, proven = true, text = false, log = [] }) {
  const w = { log, toPeer: [], toVerifier: [], promoted: false, closed: null, peerClosed: null };
  let vFrame = null, vClose = null, pFrame = null, pClose = null;
  const later = (fn) => setImmediate(fn);

  w.link = {
    peerKey, transport: "wsh", proven,
    send(frame) {
      if (w.closed !== null) throw new Error("link is not restricted");
      log.push(`send:${frame.t}${frame.t === "realm:result" ? `:${frame.ok ? "ok" : frame.reason}` : ""}`);
      w.toPeer.push(frame);
      later(() => pFrame?.(text ? JSON.stringify(frame) : structuredClone(frame)));
      return Promise.resolve();
    },
    onFrame(cb) { vFrame = cb; },
    onClose(cb) { vClose = cb; },
    promote() {
      if (w.closed !== null || w.promoted) return false;
      w.promoted = true;
      log.push("promote");
      return true;
    },
    close(reason = "closed-by-handler") {
      if (w.closed !== null || w.promoted) return false;
      w.closed = reason;
      log.push(`close:${reason}`);
      later(() => pClose?.(reason));
      return true;
    },
  };

  w.channel = {
    send(frame) {
      if (w.closed !== null || w.peerClosed !== null) throw new Error("channel closed");
      w.toVerifier.push(frame);
      later(() => { if (w.closed === null) vFrame?.(structuredClone(frame)); });
    },
    onFrame(cb) { pFrame = cb; },
    onClose(cb) { pClose = cb; },
    close(reason = "prover-closed") {
      if (w.peerClosed !== null) return;
      w.peerClosed = reason;
      later(() => { if (w.closed === null) { w.closed = `peer:${reason}`; vClose?.(reason); } });
    },
  };
  return w;
}

/** A registry with the two duck-typed methods; `policy` maps the asked scopes to the ones it grants. */
export function fakeRegistry({ log = [], policy = (s) => s, throws = false } = {}) {
  const reg = {
    grants: [], revokes: [],
    grantRealmScopes(g) {
      log.push("grant");
      reg.grants.push(g);
      if (throws) throw new TypeError("boom");
      const granted = policy(g.scopes);
      return { granted, dropped: g.scopes.filter((s) => !granted.includes(s)).map((scope) => ({ scope, reason: "not-in-allow-list" })) };
    },
    revokeRealmGrants(sel) {
      log.push("revoke");
      reg.revokes.push(sel);
      return 0;
    },
  };
  return reg;
}
