// The prover's half of the realm exchange (docs/design/realms.md 5.5): the dialler presents its credential to a host that
// holds the link restricted. It is written against the same duck-typed channel the verifier's seam gives a handler:
//
//   channel = { send(frame), onFrame(cb), onClose(cb), close(reason) }
//
// Frames may be objects or JSON text. A peer that does not speak realms ignores the unknown frame types, so the prover
// treats "no `realm:*` frame at all before `timeoutMs`" as `peer-does-not-speak-realms`; a peer that began the exchange
// and then stalled is `timeout`. Frames that are not `realm:` frames are ignored (an older peer's ordinary traffic); a
// malformed `realm:` frame ends the exchange with `bad-frame`.
//
// Order, so the verifier never sees a credential it is not ready for: the prover sends `hello`; on the verifier's hello,
// if the verifier is ahead it asks for the descriptor (and adopts it, verified), if the prover is ahead it waits to be
// asked and answers, and only then does it send the credential.
//
// Resolves `{ ok: true, role, notAfter }` (whole seconds) or `{ ok: false, reason }`. Reasons beyond the verifier's own
// (see verifier.mjs): peer-does-not-speak-realms, timeout, peer-closed, and the prover's own bad-frame, wrong-realm,
// unexpected-frame, descriptor-rejected. After it settles it ignores the channel: the caller owns the link.
import { parseFrame } from "./frames.mjs";
import { need } from "./validate.mjs";

let proverCount = 0;

/**
 * @param {object} opts
 * @param {string} opts.pinnedId
 * @param {ReturnType<import("./store.mjs").createDescriptorStore>} opts.store the prover's own descriptor store
 * @param {string | null} [opts.credential] the credential text; null asks for the open-mode default role
 * @param {{ send: Function, onFrame: Function, onClose: Function, close: Function }} opts.channel
 * @param {number | (() => number)} [opts.now]
 * @param {number} [opts.timeoutMs=5000]
 * @returns {Promise<{ ok: true, role?: string, notAfter?: number } | { ok: false, reason: string }>}
 */
export function createRealmProver({ pinnedId, store, credential = null, channel, now, timeoutMs = 5000 } = {}) {
  need(typeof pinnedId === "string" && pinnedId !== "", "createRealmProver needs a pinnedId");
  need(store && typeof store.offer === "function" && typeof store.current === "function", "createRealmProver needs a descriptor store");
  need(channel && ["send", "onFrame", "onClose", "close"].every((m) => typeof channel[m] === "function"), "createRealmProver needs a channel");
  need(credential === null || typeof credential === "string", "credential is text or null");
  need(Number.isFinite(timeoutMs) && timeoutMs > 0, "timeoutMs is a positive number");
  void now; // the store carries the clock; accepted so callers can pass one set of options

  const linkId = `prover:${++proverCount}`;
  return new Promise((resolve) => {
    const st = { done: false, sawRealm: false, hello: null, asked: false, expectAsk: false, credentialSent: false };
    const timer = setTimeout(() => finish({ ok: false, reason: st.sawRealm ? "timeout" : "peer-does-not-speak-realms" }), timeoutMs);

    function finish(result) {
      if (st.done) return;
      st.done = true;
      clearTimeout(timer);
      store.forget?.(linkId);
      resolve(result);
      if (!result.ok && result.reason !== "peer-closed") {
        try { channel.close(result.reason); } catch { /* already gone */ }
      }
    }

    const put = async (frame) => {
      try { await channel.send(frame); } catch { /* a closed link ends through onClose or the result */ }
    };
    const sendCredential = async () => {
      if (st.credentialSent) return;
      st.credentialSent = true;
      await put({ t: "realm:credential", text: credential });
    };

    async function onFrame(raw) {
      await store.ready; // a baked descriptor is still being verified: do not read "none held" too early
      if (st.done) return;
      const parsed = parseFrame(raw);
      if (!parsed.ok) {
        if (parsed.realm) { st.sawRealm = true; finish({ ok: false, reason: "bad-frame" }); }
        return; // foreign traffic
      }
      st.sawRealm = true;
      const f = parsed.frame;
      const cur = store.current();
      const mine = cur?.serial ?? 0;
      switch (f.t) {
        case "realm:hello":
          if (st.hello) return finish({ ok: false, reason: "unexpected-frame" });
          if (f.id !== pinnedId) return finish({ ok: false, reason: "wrong-realm" });
          st.hello = f;
          if (f.serial > mine) {
            st.asked = true;
            await put({ t: "realm:need-descriptor", have: mine });
          } else if (mine > f.serial) {
            st.expectAsk = true;
          } else {
            await sendCredential();
          }
          return;
        case "realm:need-descriptor": {
          const text = store.export?.();
          if (!cur || !text || f.have >= cur.serial) return;
          await put({ t: "realm:descriptor", text });
          if (st.expectAsk) await sendCredential();
          return;
        }
        case "realm:descriptor": {
          if (!st.asked) return finish({ ok: false, reason: "unexpected-frame" });
          st.asked = false;
          const v = await store.offer(f.text, { linkId });
          if (st.done) return;
          const caughtUp = !v.ok && v.reason === "stale-serial" && (store.current()?.serial ?? 0) >= st.hello.serial;
          if (!v.ok && !caughtUp) return finish({ ok: false, reason: v.reason === "rate-limited" ? "rate-limited" : "descriptor-rejected" });
          await sendCredential();
          return;
        }
        case "realm:result":
          if (!f.ok) return finish({ ok: false, reason: f.reason ?? "refused" });
          return finish({ ok: true, ...(f.role !== undefined ? { role: f.role } : {}), ...(f.notAfter !== undefined ? { notAfter: f.notAfter } : {}) });
        default:
          return finish({ ok: false, reason: "unexpected-frame" }); // a credential flows the other way
      }
    }

    let chain = Promise.resolve();
    channel.onFrame((raw) => {
      chain = chain.then(() => onFrame(raw)).catch(() => finish({ ok: false, reason: "internal-error" }));
      return chain;
    });
    channel.onClose(() => finish({ ok: false, reason: "peer-closed" }));

    (async () => {
      await store.ready;
      const cur = store.current();
      await put({ t: "realm:hello", id: pinnedId, serial: cur?.serial ?? 0, epoch: cur?.epoch ?? 0 });
    })().catch(() => finish({ ok: false, reason: "internal-error" }));
  });
}
