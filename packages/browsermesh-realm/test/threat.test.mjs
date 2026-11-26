// Rows of docs/design/realms.md section 6 that are pure logic.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  issueCredential, verifyCredential, checkSubject, adoptDescriptor, createCredentialTracker,
} from "../src/index.mjs";
import { buildRealm, T0, DAY } from "./helpers.mjs";

const reason = (v) => (v.ok ? "ok" : v.reason);

const cred = (r, o = {}, issuer = r.issuerA) => issueCredential({
  realm: r.id, subject: r.aliceKey, role: "member", serial: 1, notBefore: T0, notAfter: T0 + DAY, epoch: r.descriptor.epoch, ...o,
}, issuer).then((x) => x.text);

describe("threat model (pure logic)", () => {
  it("a thief of one credential cannot use it without the subject key", async () => {
    const r = await buildRealm();
    const v = await verifyCredential(await cred(r), r.descriptor, { now: T0 });
    assert.equal(checkSubject(v.credential, r.bobKey).ok, false);
    assert.equal(checkSubject(v.credential, r.aliceKey).ok, true);
  });

  it("a compromised issuer cannot mint past the ttl", async () => {
    const r = await buildRealm(); // ttl 7 days
    const text = await cred(r, { notAfter: T0 + 365 * DAY });
    const inWindow = await verifyCredential(text, r.descriptor, { now: T0 + 6 * DAY });
    assert.equal(inWindow.ok, true);
    assert.equal(inWindow.clamped, true);
    assert.equal(inWindow.effective.notAfter, T0 + 7 * DAY);
    assert.equal(reason(await verifyCredential(text, r.descriptor, { now: T0 + 7 * DAY + 301 })), "expired");
    assert.equal(reason(await verifyCredential(text, r.descriptor, { now: T0 + 30 * DAY })), "expired");
  });

  it("a compromised issuer cannot backdate notBefore to stretch a lifetime", async () => {
    const r = await buildRealm();
    const text = await cred(r, { notBefore: T0 - 30 * DAY, notAfter: T0 + 30 * DAY });
    const v = await verifyCredential(text, r.descriptor, { now: T0 });
    assert.equal(reason(v), "expired", "lifetime is measured from notBefore, so a backdated window ends in the past");
    const near = await cred(r, { notBefore: T0 - 2 * DAY, notAfter: T0 + 30 * DAY });
    const ok = await verifyCredential(near, r.descriptor, { now: T0 });
    assert.equal(ok.ok, true);
    assert.equal(ok.effective.notAfter, T0 + 5 * DAY, "never later than notBefore + ttl");
  });

  it("a removed issuer's credentials die once the new descriptor is adopted", async () => {
    const r = await buildRealm();
    const text = await cred(r);
    assert.equal((await verifyCredential(text, r.descriptor, { now: T0 })).ok, true);
    const next = await buildRealm({ serial: 2, issuers: [r.fields.issuers[1]] });
    const adopted = await adoptDescriptor(r.descriptor, next.text, { pinnedId: r.id, now: T0 });
    assert.equal(adopted.ok, true);
    assert.equal(reason(await verifyCredential(text, adopted.descriptor, { now: T0 })), "issuer-not-listed");
  });

  it("replay of an old descriptor does not resurrect a removed issuer", async () => {
    const r = await buildRealm();
    const next = await buildRealm({ serial: 2, issuers: [r.fields.issuers[1]] });
    const replay = await adoptDescriptor(next.descriptor, r.text, { pinnedId: r.id, now: T0 });
    assert.equal(reason(replay), "stale-serial");
  });

  it("an epoch bump ends every older credential, and the tracker keeps it ended after a replayed descriptor", async () => {
    const r = await buildRealm();
    const old = await cred(r);
    const next = await buildRealm({ serial: 2, epoch: 1 });
    assert.equal(reason(await verifyCredential(old, next.descriptor, { now: T0 })), "epoch-too-old");
    const tracker = createCredentialTracker();
    tracker.noteEpoch(r.id, 1);
    const v = await verifyCredential(old, r.descriptor, { now: T0 }); // a verifier fooled back onto the old descriptor
    assert.equal(v.ok, true);
    assert.equal(tracker.check(v).reason, "epoch-too-old");
  });

  it("a replayed older credential of the same subject and role is refused once a newer serial is held", async () => {
    const r = await buildRealm();
    const tracker = createCredentialTracker();
    await verifyCredential(await cred(r, { serial: 10 }), r.descriptor, { now: T0, tracker });
    assert.equal(reason(await verifyCredential(await cred(r, { serial: 9 }), r.descriptor, { now: T0, tracker })), "stale-serial");
  });

  it("an attacker cannot upgrade a role by editing it (signature covers the role)", async () => {
    const r = await buildRealm();
    const forged = (await cred(r, { role: "guest" })).replace('"role":"guest"', '"role":"member"');
    assert.equal(reason(await verifyCredential(forged, r.descriptor, { now: T0 })), "bad-signature");
  });
});
