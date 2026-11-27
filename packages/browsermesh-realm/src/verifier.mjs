// The verifier's half of the realm exchange (docs/design/realms.md 5.5): the handler a host plugs into its link-admission
// seam (`createLinkAdmission({ handler })`). It runs on a RESTRICTED link: a link whose peer key is not yet known to the
// host, carrying nothing but this conversation.
//
//   verifier                                   peer
//   hello (serial, epoch)       ------>
//                               <------        hello
//   [peer's serial is higher]   need-descriptor ------>        (verify it, adopt it, never trust it)
//                               <------        descriptor
//                               <------        credential (or null, for the open-mode guest role)
//   verify, check subject = the key the LINK proved, check order (tracker), compute scopes from the descriptor,
//   registry.grantRealmScopes(...)         <- strictly BEFORE the result and the promote, or the registry's default
//                                             access watcher closes the promoted peer at its next access change
//   result { ok: true, role, notAfter }  ------>      then link.promote()
//
// Any failure: `realm:result { ok: false, reason }`, then `link.close(reason)`. A peer that goes quiet is the seam's
// deadline's problem, not ours: this handler holds no timer.
//
// Reasons (stable; also the `reason` of the `refused` event):
//   protocol:    bad-frame, unexpected-frame, too-many-frames, wrong-realm, unproven
//   descriptor:  descriptor-rejected (a peer's descriptor did not verify or was not higher; detail goes to onEvent),
//                rate-limited, no-descriptor, descriptor-stale
//   credential:  no-credential, credential-rejected, and the package's own: malformed, too-large, not-canonical,
//                unsupported-version, issuer-not-listed, bad-signature, unknown-role, epoch-too-old, revoked,
//                not-yet-valid, expired, stale-serial, tracker-full, subject-mismatch
//   grant:       no-grant (the registry granted nothing), grant-error (it threw)
//   internal:    internal-error
//
// The registry is DUCK-TYPED (`grantRealmScopes`, `revokeRealmGrants`): this package never imports browsermesh-apps.
import { createCredentialTracker } from "./tracker.mjs";
import { verifyCredential, checkSubject } from "./credential.mjs";
import { isStale } from "./descriptor.mjs";
import { defaultRole } from "./roles.mjs";
import { resolveNow } from "./keys.mjs";
import { parseFrame } from "./frames.mjs";
import { need } from "./validate.mjs";

const DEFAULTS = Object.freeze({
  /** Frames accepted from one peer on one link before it is cut off. */
  maxFrames: 16,
  /** Descriptors sent to one peer on one link. */
  maxDescriptorReplies: 2,
  /** Seconds an open-mode guest grant lasts (capped by the descriptor's ttl). */
  guestTtl: 3600,
});

/** Reasons from `verifyCredential` that are passed to the peer as they are; anything else is `credential-rejected`. */
const CREDENTIAL_REASONS = new Set([
  "malformed", "too-large", "not-canonical", "unsupported-version", "wrong-realm", "descriptor-stale", "issuer-not-listed",
  "bad-signature", "unknown-role", "epoch-too-old", "revoked", "not-yet-valid", "expired", "stale-serial", "tracker-full",
]);

/**
 * @param {object} opts
 * @param {string} opts.pinnedId the realm id this host honours
 * @param {ReturnType<import("./store.mjs").createDescriptorStore>} opts.store
 * @param {{ grantRealmScopes: Function, revokeRealmGrants: Function }} opts.registry duck-typed (a `PeerRegistry`)
 * @param {number | (() => number)} [opts.now] whole seconds
 * @param {number} [opts.skew] clock-skew tolerance in seconds (capped at 300 by the package)
 * @param {ReturnType<typeof createCredentialTracker>} [opts.tracker] share one across verifiers; default a private one
 * @param {Partial<typeof DEFAULTS>} [opts.limits]
 * @param {(event: object) => void} [opts.onEvent] `refused` {peerKey, reason, detail?}, `granted` {peerKey, role, serial,
 *   granted, dropped}, `promoted`, `descriptor-adopted` {serial, epoch}
 * @returns {{ handler: (link: object) => Promise<void>, tracker: object }}
 */
export function createRealmVerifier({ pinnedId, store, registry, now, skew, tracker = createCredentialTracker(), limits, onEvent } = {}) {
  need(typeof pinnedId === "string" && pinnedId !== "", "createRealmVerifier needs a pinnedId");
  need(store && typeof store.offer === "function" && typeof store.current === "function", "createRealmVerifier needs a descriptor store");
  need(registry && typeof registry.grantRealmScopes === "function" && typeof registry.revokeRealmGrants === "function",
    "createRealmVerifier needs a registry with grantRealmScopes and revokeRealmGrants");
  const L = { ...DEFAULTS, ...limits };
  const emit = (event) => { try { onEvent?.(event); } catch { /* a listener may not break a link */ } };
  let nextLink = 0;

  // A newer descriptor can end grants: a higher epoch ends every grant issued under an older one, and a newly listed
  // revoked serial ends that credential's grant. The registry announces the access change, so open links re-check.
  store.onAdopt((d, prev) => {
    tracker.noteEpoch(d.id, d.epoch);
    emit({ type: "descriptor-adopted", serial: d.serial, epoch: d.epoch });
    try {
      if (d.epoch > (prev?.epoch ?? 0)) registry.revokeRealmGrants({ realmId: d.id, belowEpoch: d.epoch });
      const had = new Set(prev?.revoked ?? []);
      for (const serial of d.revoked) if (!had.has(serial)) registry.revokeRealmGrants({ realmId: d.id, serial });
    } catch { /* the registry's own failure may not break adoption */ }
  });

  function handler(link) {
    const linkId = ++nextLink;
    const peerKey = link.peerKey;
    const st = { frames: 0, replies: 0, peer: null, awaiting: false, credentialSeen: false, finished: false };
    let settle;
    const done = new Promise((resolve) => { settle = resolve; });

    const end = () => {
      st.finished = true;
      store.forget?.(linkId);
    };

    async function refuse(reason, detail) {
      if (st.finished) return;
      end();
      emit({ type: "refused", peerKey, reason, ...(detail ? { detail } : {}) });
      try { await link.send({ t: "realm:result", ok: false, reason }); } catch { /* the link may already be gone */ }
      link.close(reason);
      settle();
    }

    const send = (frame) => link.send(frame);
    const t = () => resolveNow(now);

    async function present(text) {
      st.credentialSeen = true;
      const d = store.current();
      if (!d) return refuse("no-descriptor");
      if (isStale(d, t())) return refuse("descriptor-stale");
      tracker.noteEpoch(d.id, d.epoch);

      let role, serial, epoch, notAfter, verified = null;
      if (text === null) {
        role = defaultRole(d);
        if (role === null) return refuse("no-credential");
        serial = 0;
        epoch = d.epoch;
        notAfter = t() + Math.min(d.ttl, L.guestTtl);
        if (d.validUntil !== undefined) notAfter = Math.min(notAfter, d.validUntil);
      } else {
        // No tracker here: a serial is remembered only once the subject is proven and the grant made, so a stolen
        // credential presented by the wrong key advances nothing.
        verified = await verifyCredential(text, d, { now, skew });
        if (st.finished) return;
        if (!verified.ok) return refuse(CREDENTIAL_REASONS.has(verified.reason) ? verified.reason : "credential-rejected", verified.reason);
        const subject = checkSubject(verified, peerKey);
        if (!subject.ok) return refuse("subject-mismatch");
        const order = tracker.check(verified, { now });
        if (!order.ok) return refuse(CREDENTIAL_REASONS.has(order.reason) ? order.reason : "credential-rejected", order.reason);
        ({ role, serial, epoch } = { role: verified.credential.role, serial: verified.credential.serial, epoch: verified.credential.epoch });
        notAfter = verified.effective.notAfter;
      }

      // Grant, then remember the serial, with nothing awaited in between.
      let res;
      try {
        res = registry.grantRealmScopes({
          realmId: d.id, serial, peerKey, role, scopes: [...d.roles[role]], notAfter: notAfter * 1000, epoch,
        });
      } catch (err) {
        return refuse("grant-error", String(err?.message ?? err));
      }
      if (!Array.isArray(res?.granted) || res.granted.length === 0) return refuse("no-grant");
      if (verified) tracker.admit(verified, { now });
      emit({ type: "granted", peerKey, role, serial, granted: res.granted, dropped: res.dropped ?? [] });

      end();
      try {
        await send({ t: "realm:result", ok: true, role, notAfter });
      } catch {
        link.close("send-failed");
        settle();
        return;
      }
      if (link.promote()) emit({ type: "promoted", peerKey, role });
      settle();
    }

    async function onFrame(raw) {
      if (st.finished) return;
      if (++st.frames > L.maxFrames) return refuse("too-many-frames");
      const parsed = parseFrame(raw);
      if (!parsed.ok) return refuse("bad-frame");
      const f = parsed.frame;
      const cur = store.current();
      switch (f.t) {
        case "realm:hello":
          if (st.peer) return refuse("unexpected-frame");
          if (f.id !== pinnedId) return refuse("wrong-realm");
          st.peer = f;
          if (f.serial > (cur?.serial ?? 0)) {
            st.awaiting = true;
            await send({ t: "realm:need-descriptor", have: cur?.serial ?? 0 });
          }
          return;
        case "realm:need-descriptor": {
          const text = store.export?.();
          if (!cur || !text || f.have >= cur.serial) return;
          if (++st.replies > L.maxDescriptorReplies) return refuse("too-many-frames");
          await send({ t: "realm:descriptor", text });
          return;
        }
        case "realm:descriptor": {
          if (!st.awaiting) return refuse("unexpected-frame");
          st.awaiting = false;
          const v = await store.offer(f.text, { linkId });
          if (st.finished) return;
          if (v.ok) return;
          if (v.reason === "rate-limited") return refuse("rate-limited");
          // Someone else adopted at least what this peer announced while we waited: nothing was lost.
          if (v.reason === "stale-serial" && (store.current()?.serial ?? 0) >= st.peer.serial) return;
          return refuse("descriptor-rejected", v.reason);
        }
        case "realm:credential":
          if (!st.peer || st.awaiting || st.credentialSeen) return refuse("unexpected-frame");
          return present(f.text);
        default:
          return refuse("unexpected-frame"); // realm:result flows the other way
      }
    }

    // Registered synchronously: the seam may deliver a frame the moment the handler returns.
    let chain = (async () => {
      if (!link.proven) return refuse("unproven");
      await store.ready;
      if (st.finished) return;
      const cur = store.current();
      await send({ t: "realm:hello", id: pinnedId, serial: cur?.serial ?? 0, epoch: cur?.epoch ?? 0 });
    })().catch(() => refuse("internal-error"));
    link.onFrame((raw) => {
      chain = chain.then(() => onFrame(raw)).catch(() => refuse("internal-error"));
      return chain;
    });
    link.onClose(() => { if (!st.finished) end(); settle(); });
    return done;
  }

  return { handler, tracker };
}
