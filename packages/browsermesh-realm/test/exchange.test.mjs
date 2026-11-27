import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createRealmVerifier, createRealmProver, createDescriptorStore, createCredentialTracker, createRotation, createDescriptor, signDescriptor,
  issueCredential, publicKeyOf, keyId, MAX_DESCRIPTOR_BYTES,
} from "../src/index.mjs";
import { buildRealm, identityFromSeed, SEEDS, T0, DAY, ROLES, RENDEZVOUS } from "./helpers.mjs";
import { wire, fakeRegistry, until, settle } from "./exchange-helpers.mjs";

const NOW = T0 + 100;
const reason = (v) => (v.ok ? "ok" : v.reason);

/** A realm, a verifier over it, and helpers to run provers and scripted peers against it. */
async function world({ realm, registry: regOpts, verifier: vOpts, now = NOW } = {}) {
  const r = await buildRealm(realm);
  const clock = { now };
  const log = [];
  const events = [];
  const registry = fakeRegistry({ log, ...regOpts });
  const store = createDescriptorStore({ pinnedId: r.id, held: r.text, now: () => clock.now });
  await store.ready;
  const verifier = createRealmVerifier({ pinnedId: r.id, store, registry, now: () => clock.now, onEvent: (e) => events.push(e), ...vOpts });
  const cred = async (over = {}, issuer = r.issuerA, subject = r.aliceKey) => (await issueCredential({
    realm: r.id, subject, role: "member", serial: 1, notBefore: T0, notAfter: T0 + DAY, epoch: r.descriptor.epoch, ...over,
  }, issuer)).text;
  const proverStore = async (text = r.text) => {
    const s = createDescriptorStore({ pinnedId: r.id, held: text, now: () => clock.now });
    await s.ready;
    return s;
  };

  /** Run the real prover against the verifier; resolves { w, result }. */
  async function connect(peerKey, credential, { proven = true, text = false, store, timeoutMs = 3000 } = {}) {
    const pstore = store ?? (await proverStore());
    const w = wire({ peerKey, proven, text, log });
    const done = verifier.handler(w.link);
    const result = await createRealmProver({
      pinnedId: r.id, store: pstore, credential, channel: w.channel, now: () => clock.now, timeoutMs,
    });
    await done?.catch?.(() => {});
    return { w, result };
  }

  /** A scripted peer: you send frames, it records what the verifier sends. */
  function raw(peerKey, { proven = true } = {}) {
    const w = wire({ peerKey, proven, log });
    const got = [];
    w.channel.onFrame((f) => got.push(typeof f === "string" ? JSON.parse(f) : f));
    w.channel.onClose(() => {});
    verifier.handler(w.link);
    return {
      w, got, send: (f) => w.channel.send(f),
      hello: (over = {}) => w.channel.send({ t: "realm:hello", id: r.id, serial: r.descriptor.serial, epoch: r.descriptor.epoch, ...over }),
      last: () => got.at(-1),
      refusal: () => got.find((f) => f.t === "realm:result" && f.ok === false)?.reason,
    };
  }
  return { r, clock, log, events, registry, store, verifier, cred, proverStore, connect, raw };
}

describe("realm exchange: happy paths", () => {
  it("invite mode: a stranger with a valid credential is granted the role's scopes, then told, then promoted (in that order)", async () => {
    const w = await world();
    const { w: wr, result } = await w.connect(w.r.aliceKey, await w.cred());
    assert.deepEqual(result, { ok: true, role: "member", notAfter: T0 + DAY });
    assert.equal(wr.promoted, true);
    assert.equal(w.registry.grants.length, 1);
    assert.deepEqual(w.registry.grants[0], {
      realmId: w.r.id, serial: 1, peerKey: w.r.aliceKey, role: "member", scopes: ROLES.member, notAfter: (T0 + DAY) * 1000, epoch: 0,
    });
    const i = (s) => w.log.indexOf(s);
    assert.ok(i("grant") >= 0 && i("grant") < i("send:realm:result:ok") && i("send:realm:result:ok") < i("promote"), w.log.join(" "));
    assert.equal(w.events.find((e) => e.type === "granted")?.role, "member");
  });

  it("works when frames arrive as JSON text (wsh delivers text)", async () => {
    const w = await world();
    const { result } = await w.connect(w.r.aliceKey, await w.cred(), { text: true });
    assert.equal(result.ok, true);
  });

  it("open mode: a peer with no credential gets the default guest role, by the same path", async () => {
    const w = await world({ realm: { mode: "open" } });
    const { w: wr, result } = await w.connect(w.r.bobKey, null);
    assert.equal(result.ok, true);
    assert.equal(result.role, "guest");
    assert.equal(wr.promoted, true);
    assert.equal(w.registry.grants[0].role, "guest");
    assert.deepEqual(w.registry.grants[0].scopes, ROLES.guest);
    assert.equal(w.registry.grants[0].notAfter, (NOW + 3600) * 1000, "a guest grant lasts min(ttl, guestTtl)");
    assert.ok(w.log.indexOf("grant") < w.log.indexOf("promote"));
  });

  it("open mode: guest only. A peer with no credential never gets a privileged role; a credential still gets its role", async () => {
    const w = await world({ realm: { mode: "open" } });
    await w.connect(w.r.bobKey, null);
    assert.equal(w.registry.grants.every((g) => g.role === "guest"), true);
    const { result } = await w.connect(w.r.aliceKey, await w.cred());
    assert.equal(result.role, "member");
  });

  it("invite mode: a privileged role needs a credential; no credential is refused", async () => {
    const w = await world();
    const { w: wr, result } = await w.connect(w.r.bobKey, null);
    assert.deepEqual(result, { ok: false, reason: "no-credential" });
    assert.equal(wr.promoted, false);
    assert.equal(wr.closed, "no-credential");
    assert.equal(w.registry.grants.length, 0);
  });

  it("the policy decides: a role scope the registry drops is reported, and what is left is what the peer holds", async () => {
    const w = await world({ registry: { policy: (s) => s.filter((x) => x !== "objects:window:get") } });
    const { result } = await w.connect(w.r.aliceKey, await w.cred());
    assert.equal(result.ok, true);
    const g = w.events.find((e) => e.type === "granted");
    assert.deepEqual(g.granted, ["mcp:search:call", "protocol:mcp:open"]);
    assert.deepEqual(g.dropped, [{ scope: "objects:window:get", reason: "not-in-allow-list" }]);
  });

  it("a registry that grants nothing is a refusal (no-grant): never promoted", async () => {
    const w = await world({ registry: { policy: () => [] } });
    const { w: wr, result } = await w.connect(w.r.aliceKey, await w.cred());
    assert.deepEqual(result, { ok: false, reason: "no-grant" });
    assert.equal(wr.promoted, false);
    assert.equal(wr.closed, "no-grant");
  });

  it("a registry that throws is a refusal (grant-error), not a crash", async () => {
    const w = await world({ registry: { throws: true } });
    const { w: wr, result } = await w.connect(w.r.aliceKey, await w.cred());
    assert.deepEqual(result, { ok: false, reason: "grant-error" });
    assert.equal(wr.promoted, false);
  });
});

describe("realm exchange: credential refusals", () => {
  const refused = async (w, over, expected, { issuer, subjectKey, proven, subject } = {}) => {
    const key = subjectKey ?? w.r.aliceKey;
    const { w: wr, result } = await w.connect(key, await w.cred(over, issuer ?? w.r.issuerA, subject ?? w.r.aliceKey), { proven });
    assert.equal(reason(result), expected);
    assert.equal(wr.promoted, false, `${expected}: not promoted`);
    assert.equal(wr.closed, expected, `${expected}: closed with the reason`);
    assert.equal(w.registry.grants.length, 0, `${expected}: nothing granted`);
  };

  it("wrong subject: a credential presented by a key that is not its subject", async () => {
    const w = await world();
    await refused(w, {}, "subject-mismatch", { subjectKey: w.r.bobKey });
  });

  it("proven:false: a credential counts only on a link that proved the peer's key", async () => {
    const w = await world();
    await refused(w, {}, "unproven", { proven: false });
  });

  it("proven:false: not even a guest in open mode", async () => {
    const w = await world({ realm: { mode: "open" } });
    const { result } = await w.connect(w.r.bobKey, null, { proven: false });
    assert.deepEqual(result, { ok: false, reason: "unproven" });
    assert.equal(w.registry.grants.length, 0);
  });

  it("expired, backdated and not-yet-valid", async () => {
    const w = await world();
    await refused(w, { notBefore: T0 - 2 * DAY, notAfter: T0 - DAY }, "expired");
    const w2 = await world();
    await refused(w2, { notBefore: T0 - 30 * DAY, notAfter: T0 + DAY }, "expired"); // backdating only moves the window into the past
    const w3 = await world();
    await refused(w3, { notBefore: T0 + DAY, notAfter: T0 + 2 * DAY }, "not-yet-valid");
  });

  it("clamped: the grant ends at min(notAfter, notBefore + ttl), in milliseconds", async () => {
    const w = await world();
    const { result } = await w.connect(w.r.aliceKey, await w.cred({ notAfter: T0 + 30 * DAY }));
    assert.equal(result.ok, true);
    assert.equal(result.notAfter, T0 + 7 * DAY);
    assert.equal(w.registry.grants[0].notAfter, (T0 + 7 * DAY) * 1000);
  });

  it("revoked serial, removed issuer, older epoch, unknown role, other realm", async () => {
    await refused(await world({ realm: { revoked: [5] } }), { serial: 5 }, "revoked");
    const probe = await buildRealm();
    const only = [{ key: probe.issuerAKey, notAfter: T0 + 90 * DAY }];
    const w = await world({ realm: { issuers: only } });
    await refused(w, {}, "issuer-not-listed", { issuer: w.r.issuerB });
    await refused(await world({ realm: { epoch: 2 } }), { epoch: 1 }, "epoch-too-old");
    await refused(await world(), { role: "root" }, "unknown-role");
    const other = await world();
    await refused(other, { realm: other.r.aliceKey }, "wrong-realm");
  });

  it("a stale descriptor snapshot (past validUntil) honours nothing", async () => {
    // held and verified while fresh; the clock then passes validUntil
    const w = await world({ realm: { validUntil: T0 + 50 }, now: T0 + 10 });
    const credential = await w.cred();
    const proverStore = await w.proverStore();
    w.clock.now = T0 + 60;
    const { result: r1 } = await w.connect(w.r.aliceKey, credential, { store: proverStore });
    assert.equal(reason(r1), "descriptor-stale");
    assert.equal(w.registry.grants.length, 0);
    const guest = await world({ realm: { mode: "open", validUntil: T0 + 50 }, now: T0 + 10 });
    const gStore = await guest.proverStore();
    guest.clock.now = T0 + 60;
    const { result } = await guest.connect(guest.r.bobKey, null, { store: gStore });
    assert.equal(reason(result), "descriptor-stale");
  });

  it("an older serial arriving after a newer one is refused (the registry does not order serials)", async () => {
    const w = await world();
    assert.equal((await w.connect(w.r.aliceKey, await w.cred({ serial: 5 }))).result.ok, true);
    const { result, w: wr } = await w.connect(w.r.aliceKey, await w.cred({ serial: 3 }));
    assert.equal(reason(result), "stale-serial");
    assert.equal(wr.promoted, false);
    assert.equal(w.registry.grants.length, 1, "the older credential never reached the registry");
  });

  it("a credential refused for another reason does not advance the tracker", async () => {
    const w = await world();
    // bob steals alice's serial-9 credential and fails on subject; alice's own serial-5 still works afterwards
    await refused(w, { serial: 9 }, "subject-mismatch", { subjectKey: w.r.bobKey });
    const { result } = await w.connect(w.r.aliceKey, await w.cred({ serial: 5 }));
    assert.equal(result.ok, true);
  });

  it("the same serial presented again (a reconnect) is accepted", async () => {
    const w = await world();
    assert.equal((await w.connect(w.r.aliceKey, await w.cred({ serial: 2 }))).result.ok, true);
    assert.equal((await w.connect(w.r.aliceKey, await w.cred({ serial: 2 }))).result.ok, true);
  });
});

describe("realm exchange: renewal by a second exchange", () => {
  it("a newer-serial credential replaces the grant (same realm, peer, role); an older one afterwards is refused", async () => {
    const w = await world();
    assert.equal((await w.connect(w.r.aliceKey, await w.cred({ serial: 1, notAfter: T0 + DAY }))).result.ok, true);
    const second = await w.connect(w.r.aliceKey, await w.cred({ serial: 2, notAfter: T0 + 2 * DAY }));
    assert.deepEqual(second.result, { ok: true, role: "member", notAfter: T0 + 2 * DAY });
    assert.equal(w.registry.grants.length, 2);
    assert.equal(w.registry.grants[1].serial, 2);
    assert.equal(w.registry.grants[1].notAfter, (T0 + 2 * DAY) * 1000);
    const older = await w.connect(w.r.aliceKey, await w.cred({ serial: 1, notAfter: T0 + 3 * DAY }));
    assert.equal(reason(older.result), "stale-serial");
    assert.equal(w.registry.grants.length, 2);
  });

  it("a caller-supplied tracker is used (so the host can share it across verifiers)", async () => {
    const tracker = createCredentialTracker();
    const w = await world({ verifier: { tracker } });
    await w.connect(w.r.aliceKey, await w.cred({ serial: 4 }));
    assert.equal(tracker.size, 1);
  });
});

describe("realm exchange: descriptors", () => {
  const editor = ["notes:doc:edit"];
  const richer = (over = {}) => ({ serial: 2, roles: { ...ROLES, editor }, ...over });

  it("a peer with a higher serial is asked for its descriptor, which is verified, adopted and used", async () => {
    const w = await world();
    const newer = await buildRealm(richer());
    const { result } = await w.connect(w.r.aliceKey, await w.cred({ role: "editor" }), { store: await w.proverStore(newer.text) });
    assert.deepEqual(reason(result), "ok");
    assert.equal(w.store.current().serial, 2);
    assert.deepEqual(w.registry.grants[0].scopes, editor);
    assert.ok(w.log.indexOf("grant") < w.log.indexOf("promote"));
    assert.equal(w.events.some((e) => e.type === "descriptor-adopted" && e.serial === 2), true);
  });

  it("without the newer descriptor the same credential would have been refused (unknown-role)", async () => {
    const w = await world();
    const { result } = await w.connect(w.r.aliceKey, await w.cred({ role: "editor" }));
    assert.equal(reason(result), "unknown-role");
  });

  it("when OUR serial is higher the prover asks for and adopts ours, then presents its credential", async () => {
    const newer = await buildRealm(richer());
    const w = await world({ realm: richer() });
    const pstore = await w.proverStore((await buildRealm()).text);
    const { result } = await w.connect(w.r.aliceKey, await w.cred({ role: "editor" }), { store: pstore });
    assert.equal(reason(result), "ok");
    assert.equal(pstore.current().serial, 2);
    void newer;
  });

  it("a descriptor that does not verify is refused and nothing is adopted (forged, foreign, stale lie)", async () => {
    const w = await world();
    const rogue = await identityFromSeed(SEEDS.rogue);
    const foreign = await signDescriptor(await createDescriptor({
      name: "other", serial: 9, root: { key: await publicKeyOf(rogue), chain: [] }, roles: ROLES, rendezvous: RENDEZVOUS,
    }), rogue);
    const forged = (await buildRealm({ serial: 9 })).text.replace("test realm", "xx");
    const stale = (await buildRealm()).text;
    for (const text of [forged, foreign.text, stale, "{}", "nope"]) {
      const p = w.raw(w.r.aliceKey);
      await until(() => p.got.some((f) => f.t === "realm:hello"));
      p.hello({ serial: 9 });
      await until(() => p.got.some((f) => f.t === "realm:need-descriptor"));
      assert.deepEqual(p.got.find((f) => f.t === "realm:need-descriptor"), { t: "realm:need-descriptor", have: 1 });
      p.send({ t: "realm:descriptor", text });
      await until(() => p.refusal());
      assert.equal(p.refusal(), "descriptor-rejected");
      assert.equal(p.w.closed, "descriptor-rejected");
    }
    assert.equal(w.store.current().serial, 1);
    assert.equal(w.registry.grants.length, 0);
  });

  it("a descriptor nobody asked for is a protocol violation", async () => {
    const w = await world();
    const p = w.raw(w.r.aliceKey);
    await until(() => p.got.length >= 1);
    p.send({ t: "realm:descriptor", text: (await buildRealm({ serial: 2 })).text });
    await until(() => p.refusal());
    assert.equal(p.refusal(), "unexpected-frame");
    assert.equal(w.store.current().serial, 1);
  });

  it("a credential while we are still waiting for the descriptor we asked for is out of order", async () => {
    const w = await world();
    const p = w.raw(w.r.aliceKey);
    await until(() => p.got.length >= 1);
    p.hello({ serial: 4 });
    await until(() => p.got.some((f) => f.t === "realm:need-descriptor"));
    p.send({ t: "realm:credential", text: await w.cred() });
    await until(() => p.refusal());
    assert.equal(p.refusal(), "unexpected-frame");
  });

  it("forked and regressed descriptors offered by a peer are refused (first seen wins)", async () => {
    const ids = {};
    for (const n of ["root0", "root1", "rogue"]) {
      const identity = await identityFromSeed(SEEDS[n]);
      ids[n] = { identity, key: await publicKeyOf(identity) };
    }
    const realm = await keyId(ids.root0.key);
    const rot = (to) => createRotation({ realm, pos: 1, from: ids.root0.key, to: ids[to].key, effective: T0 + 1 }, ids.root0.identity, ids[to].identity);
    const desc = async (serial, current, chain) => signDescriptor(await createDescriptor({
      name: "w", serial, root: { key: ids[current].key, chain }, roles: ROLES, rendezvous: RENDEZVOUS, genesisKey: ids.root0.key,
    }), ids[current].identity);
    const s1 = await rot("root1");
    const held = await desc(2, "root1", [s1]);
    const store = createDescriptorStore({ pinnedId: realm, held: held.text, now: T0 });
    assert.equal((await store.ready).ok, true);
    const fork = await desc(3, "rogue", [await rot("rogue")]);
    const regressed = await desc(3, "root0", []);
    assert.equal(reason(await store.offer(fork.text, { linkId: "f" })), "chain-fork");
    assert.equal(reason(await store.offer(regressed.text, { linkId: "g" })), "chain-regressed");
    assert.equal(store.current().serial, 2);
    // and through the exchange the same offers end the link with the stable reason
    const registry = fakeRegistry();
    const verifier = createRealmVerifier({ pinnedId: realm, store, registry, now: T0 });
    for (const bad of [fork, regressed]) {
      const w = wire({ peerKey: ids.rogue.key });
      const got = [];
      w.channel.onFrame((f) => got.push(f));
      verifier.handler(w.link);
      await until(() => got.length >= 1);
      w.channel.send({ t: "realm:hello", id: realm, serial: 3, epoch: 0 });
      await until(() => got.some((f) => f.t === "realm:need-descriptor"));
      w.channel.send({ t: "realm:descriptor", text: bad.text });
      await until(() => w.closed !== null);
      assert.equal(w.closed, "descriptor-rejected");
    }
    assert.equal(store.current().serial, 2);
  });

  it("an epoch rise revokes grants of older epochs, before the new credential is granted", async () => {
    const w = await world();
    const newer = await buildRealm(richer({ epoch: 1 }));
    const { result } = await w.connect(w.r.aliceKey, await w.cred({ epoch: 1 }), { store: await w.proverStore(newer.text) });
    assert.equal(result.ok, true);
    assert.deepEqual(w.registry.revokes, [{ realmId: w.r.id, belowEpoch: 1 }]);
    assert.ok(w.log.indexOf("revoke") < w.log.indexOf("grant"), w.log.join(" "));
    assert.equal(w.registry.grants[0].epoch, 1);
  });

  it("an adopted descriptor that lists newly revoked serials revokes those grants too", async () => {
    const w = await world();
    const newer = await buildRealm(richer({ revoked: [7, 9] }));
    await w.store.offer(newer.text, { linkId: "x" });
    assert.deepEqual(w.registry.revokes.map((s) => s.serial).sort(), [7, 9]);
    assert.ok(w.registry.revokes.every((s) => s.realmId === w.r.id));
  });

  it("an epoch rise through the store alone (any path) also revokes", async () => {
    const w = await world();
    await w.store.offer((await buildRealm({ serial: 3, epoch: 2 })).text, { linkId: "x" });
    assert.deepEqual(w.registry.revokes, [{ realmId: w.r.id, belowEpoch: 2 }]);
  });

  it("when the verifier holds no descriptor yet it asks for the peer's", async () => {
    const r = await buildRealm();
    const store = createDescriptorStore({ pinnedId: r.id, now: NOW });
    const registry = fakeRegistry();
    const verifier = createRealmVerifier({ pinnedId: r.id, store, registry, now: NOW });
    const w = wire({ peerKey: r.aliceKey });
    const proverStore = createDescriptorStore({ pinnedId: r.id, held: r.text, now: NOW });
    const cred = (await issueCredential({ realm: r.id, subject: r.aliceKey, role: "member", serial: 1, notBefore: T0, notAfter: T0 + DAY, epoch: 0 }, r.issuerA)).text;
    verifier.handler(w.link);
    const result = await createRealmProver({ pinnedId: r.id, store: proverStore, credential: cred, channel: w.channel, now: NOW, timeoutMs: 2000 });
    assert.equal(result.ok, true);
    assert.equal(store.current().serial, 1);
  });
});

describe("realm exchange: frames and abuse", () => {
  it("the verifier speaks first: hello with the realm id, serial and epoch", async () => {
    const w = await world({ realm: { serial: 4, epoch: 2 } });
    const p = w.raw(w.r.aliceKey);
    await until(() => p.got.length >= 1);
    assert.deepEqual(p.got[0], { t: "realm:hello", id: w.r.id, serial: 4, epoch: 2 });
  });

  it("the verifier answers the peer's hello with its own again (a first hello can be lost before the peer's session exists)", async () => {
    const w = await world({ realm: { serial: 4, epoch: 2 } });
    const p = w.raw(w.r.aliceKey);
    await until(() => p.got.length >= 1);
    p.hello({ serial: 4, epoch: 2 });
    await until(() => p.got.filter((f) => f.t === "realm:hello").length >= 2);
    assert.deepEqual(p.got.filter((f) => f.t === "realm:hello"), [
      { t: "realm:hello", id: w.r.id, serial: 4, epoch: 2 }, { t: "realm:hello", id: w.r.id, serial: 4, epoch: 2 },
    ]);
  });

  it("a prover that never saw the verifier's first hello still completes (the answer to its own hello carries it)", async () => {
    const w = await world();
    const wr = wire({ peerKey: w.r.aliceKey, log: w.log });
    const send = wr.link.send;
    let dropped = 0;
    wr.link.send = (frame) => { if (frame.t === "realm:hello" && dropped++ === 0) return Promise.resolve(); return send(frame); };
    const pstore = await w.proverStore();
    const credential = await w.cred();
    const done = w.verifier.handler(wr.link);
    const result = await createRealmProver({ pinnedId: w.r.id, store: pstore, credential, channel: wr.channel, now: () => w.clock.now, timeoutMs: 3000 });
    await done?.catch?.(() => {});
    assert.equal(dropped >= 2, true);
    assert.equal(result.ok, true, JSON.stringify(result));
  });

  it("a prover whose first hello was lost on the way still completes (it says hello again before its credential)", async () => {
    const w = await world();
    const wr = wire({ peerKey: w.r.aliceKey, log: w.log });
    const send = wr.channel.send;
    let dropped = 0;
    wr.channel.send = (frame) => { if (frame.t === "realm:hello" && dropped++ === 0) return undefined; return send(frame); };
    const pstore = await w.proverStore();
    const credential = await w.cred();
    const done = w.verifier.handler(wr.link);
    const result = await createRealmProver({ pinnedId: w.r.id, store: pstore, credential, channel: wr.channel, now: () => w.clock.now, timeoutMs: 3000 });
    await done?.catch?.(() => {});
    assert.equal(dropped >= 2, true);
    assert.equal(result.ok, true, JSON.stringify(result));
  });

  it("a hello for another realm ends the exchange (wrong-realm)", async () => {
    const w = await world();
    const p = w.raw(w.r.aliceKey);
    await until(() => p.got.length >= 1);
    p.hello({ id: "B".repeat(43) });
    await until(() => p.refusal());
    assert.equal(p.refusal(), "wrong-realm");
  });

  it("a credential before hello, and a second hello, are out of order", async () => {
    const w = await world();
    const a = w.raw(w.r.aliceKey);
    await until(() => a.got.length >= 1);
    a.send({ t: "realm:credential", text: await w.cred() });
    await until(() => a.refusal());
    assert.equal(a.refusal(), "unexpected-frame");
    const b = w.raw(w.r.aliceKey);
    await until(() => b.got.length >= 1);
    b.hello();
    b.hello({ serial: 9 });
    await until(() => b.refusal());
    assert.equal(b.refusal(), "unexpected-frame");
  });

  it("a repeat of the same hello is ignored (the prover says it again with its credential, in case the first was lost)", async () => {
    const w = await world();
    const p = w.raw(w.r.aliceKey);
    await until(() => p.got.length >= 1);
    p.hello();
    p.hello();
    p.send({ t: "realm:credential", text: await w.cred() });
    await until(() => p.got.some((f) => f.t === "realm:result"));
    assert.equal(p.got.find((f) => f.t === "realm:result").ok, true);
  });

  it("a verifier-to-prover frame sent by the peer (result) is a protocol violation", async () => {
    const w = await world();
    const p = w.raw(w.r.aliceKey);
    await until(() => p.got.length >= 1);
    p.send({ t: "realm:result", ok: true });
    await until(() => p.refusal());
    assert.equal(p.refusal(), "unexpected-frame");
  });

  it("malformed, unknown and oversized frames close the exchange with bad-frame", async () => {
    const w = await world();
    const bad = [
      { t: "realm:nope" }, { t: "mesh:ping" }, { hello: 1 }, "garbage", 42, null, [], { t: "realm:hello", id: 1 },
      { t: "realm:hello", id: w.r.id, serial: -1, epoch: 0 }, { t: "realm:credential", text: "x".repeat(3000) },
      { t: "realm:descriptor", text: "x".repeat(MAX_DESCRIPTOR_BYTES + 1) }, { t: "realm:hello", id: w.r.id, serial: 1, epoch: 0, extra: true },
    ];
    for (const f of bad) {
      const p = w.raw(w.r.aliceKey);
      await until(() => p.got.length >= 1);
      p.send(f);
      await until(() => p.refusal(), 3000, JSON.stringify(f)?.slice(0, 40));
      assert.equal(p.refusal(), "bad-frame");
      assert.equal(p.w.closed, "bad-frame");
    }
    assert.equal(w.registry.grants.length, 0);
  });

  it("an endless stream of frames is cut off (too-many-frames)", async () => {
    const w = await world({ verifier: { limits: { maxFrames: 6 } } });
    const p = w.raw(w.r.aliceKey);
    await until(() => p.got.length >= 1);
    p.hello();
    for (let i = 0; i < 20; i++) { try { p.send({ t: "realm:need-descriptor", have: 0 }); } catch { break; } }
    await until(() => p.w.closed !== null);
    assert.equal(p.w.closed, "too-many-frames");
  });

  it("need-descriptor is answered at most a couple of times per link (no amplification)", async () => {
    const w = await world({ verifier: { limits: { maxDescriptorReplies: 2 } } });
    const p = w.raw(w.r.aliceKey);
    await until(() => p.got.length >= 1);
    p.hello();
    for (let i = 0; i < 6; i++) { try { p.send({ t: "realm:need-descriptor", have: 0 }); } catch { break; } await settle(); }
    await until(() => p.w.closed !== null);
    assert.equal(p.got.filter((f) => f.t === "realm:descriptor").length, 2);
    assert.equal(p.w.closed, "too-many-frames");
  });

  it("need-descriptor with have >= ours is not answered with a descriptor", async () => {
    const w = await world();
    const p = w.raw(w.r.aliceKey);
    await until(() => p.got.length >= 1);
    p.hello();
    p.send({ t: "realm:need-descriptor", have: 1 });
    await settle(); await settle(); await settle();
    assert.equal(p.got.some((f) => f.t === "realm:descriptor"), false);
  });

  it("descriptor spam: many links announcing a high serial with forged descriptors cost a bounded number of verifications", async () => {
    const w = await world({ verifier: {}, });
    const forged = (await buildRealm({ serial: 9 })).text.replace("test realm", "xx");
    for (let i = 0; i < 40; i++) {
      const p = w.raw(w.r.aliceKey);
      await until(() => p.got.length >= 1);
      p.hello({ serial: 9 });
      await until(() => p.got.some((f) => f.t === "realm:need-descriptor"));
      p.send({ t: "realm:descriptor", text: forged });
      await until(() => p.refusal());
    }
    assert.ok(w.store.stats().verifies <= 16, `verifies: ${w.store.stats().verifies}`);
    assert.equal(w.events.some((e) => e.type === "refused" && e.reason === "rate-limited"), true);
  });

  it("a peer that never answers costs nothing: no grant, no promote, and no close by us (the seam's deadline does that)", async () => {
    const w = await world();
    const p = w.raw(w.r.aliceKey);
    await until(() => p.got.length >= 1);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(p.w.closed, null);
    assert.equal(p.w.promoted, false);
    assert.equal(w.registry.grants.length, 0);
    // the seam closes it; the handler's promise settles and does not throw
    p.w.link.close("deadline");
    await settle();
    assert.equal(p.w.closed, "deadline");
  });

  it("the peer closing mid-exchange is harmless", async () => {
    const w = await world();
    const p = w.raw(w.r.aliceKey);
    await until(() => p.got.length >= 1);
    p.hello({ serial: 3 });
    await until(() => p.got.some((f) => f.t === "realm:need-descriptor"));
    p.w.channel.close("bye");
    await settle(); await settle();
    assert.equal(w.registry.grants.length, 0);
    assert.equal(w.store.current().serial, 1);
  });

  it("the link per-peer counters are released when the link ends", async () => {
    const w = await world();
    for (let i = 0; i < 5; i++) await w.connect(w.r.aliceKey, await w.cred({ serial: i + 1 }));
    assert.ok(w.store.stats().links <= 1);
  });
});

describe("realm prover", () => {
  it("an older peer that ignores realm frames: no result before timeoutMs is peer-does-not-speak-realms", async () => {
    const r = await buildRealm();
    const w = wire({ peerKey: r.aliceKey });
    const store = createDescriptorStore({ pinnedId: r.id, held: r.text, now: NOW });
    const t0 = Date.now();
    const result = await createRealmProver({ pinnedId: r.id, store, credential: null, channel: w.channel, now: NOW, timeoutMs: 60 });
    assert.deepEqual(result, { ok: false, reason: "peer-does-not-speak-realms" });
    assert.ok(Date.now() - t0 >= 50);
    assert.equal(w.toVerifier[0].t, "realm:hello", "it did speak first");
  });

  it("a peer that speaks realms but stalls is a timeout, not 'does not speak realms'", async () => {
    const r = await buildRealm();
    const w = wire({ peerKey: r.aliceKey });
    const store = createDescriptorStore({ pinnedId: r.id, held: r.text, now: NOW });
    w.link.onFrame(() => {});
    const p = createRealmProver({ pinnedId: r.id, store, credential: null, channel: w.channel, now: NOW, timeoutMs: 60 });
    await until(() => w.toVerifier.length >= 1);
    w.link.send({ t: "realm:hello", id: r.id, serial: 1, epoch: 0 });
    assert.deepEqual(await p, { ok: false, reason: "timeout" });
  });

  it("other frames (an old peer's normal traffic) are ignored, not fatal", async () => {
    const r = await buildRealm();
    const w = wire({ peerKey: r.aliceKey });
    const store = createDescriptorStore({ pinnedId: r.id, held: r.text, now: NOW });
    w.link.onFrame(() => {});
    const p = createRealmProver({ pinnedId: r.id, store, credential: null, channel: w.channel, now: NOW, timeoutMs: 80 });
    await until(() => w.toVerifier.length >= 1);
    w.link.send({ t: "mesh:ping" });
    w.link.send("plain text");
    assert.deepEqual(await p, { ok: false, reason: "peer-does-not-speak-realms" });
  });

  it("the peer's refusal is the result, and the peer closing first is 'peer-closed'", async () => {
    const w = await world();
    const { result } = await w.connect(w.r.aliceKey, await w.cred({ role: "root" }));
    assert.deepEqual(result, { ok: false, reason: "unknown-role" });
    const r = w.r;
    const ch = wire({ peerKey: r.aliceKey });
    const store = createDescriptorStore({ pinnedId: r.id, held: r.text, now: NOW });
    const p = createRealmProver({ pinnedId: r.id, store, credential: null, channel: ch.channel, now: NOW, timeoutMs: 2000 });
    await until(() => ch.toVerifier.length >= 1);
    ch.link.close("gone");
    assert.deepEqual(await p, { ok: false, reason: "peer-closed" });
  });

  it("a verifier for another realm, or one offering a bad descriptor, is refused by the prover", async () => {
    const r = await buildRealm();
    const store = createDescriptorStore({ pinnedId: r.id, held: r.text, now: NOW });
    const a = wire({ peerKey: r.aliceKey });
    a.link.onFrame(() => {});
    const pa = createRealmProver({ pinnedId: r.id, store, credential: null, channel: a.channel, now: NOW, timeoutMs: 2000 });
    await until(() => a.toVerifier.length >= 1);
    a.link.send({ t: "realm:hello", id: "B".repeat(43), serial: 1, epoch: 0 });
    assert.deepEqual(await pa, { ok: false, reason: "wrong-realm" });

    const b = wire({ peerKey: r.aliceKey });
    b.link.onFrame(() => {});
    const pb = createRealmProver({ pinnedId: r.id, store, credential: null, channel: b.channel, now: NOW, timeoutMs: 2000 });
    await until(() => b.toVerifier.length >= 1);
    b.link.send({ t: "realm:hello", id: r.id, serial: 5, epoch: 0 });
    await until(() => b.toVerifier.some((f) => f.t === "realm:need-descriptor"));
    b.link.send({ t: "realm:descriptor", text: (await buildRealm({ serial: 5 })).text.replace("test realm", "xx") });
    assert.deepEqual(await pb, { ok: false, reason: "descriptor-rejected" });
    assert.equal(store.current().serial, 1);
  });

  it("it never sends a credential before the verifier's hello (and the descriptor, if the verifier will ask)", async () => {
    const r = await buildRealm();
    const w = wire({ peerKey: r.aliceKey });
    w.link.onFrame(() => {});
    const store = createDescriptorStore({ pinnedId: r.id, held: (await buildRealm({ serial: 3 })).text, now: NOW });
    const p = createRealmProver({ pinnedId: r.id, store, credential: "CRED", channel: w.channel, now: NOW, timeoutMs: 2000 });
    await until(() => w.toVerifier.length >= 1);
    w.link.send({ t: "realm:hello", id: r.id, serial: 1, epoch: 0 });
    await settle(); await settle();
    assert.deepEqual(w.toVerifier.map((f) => f.t), ["realm:hello", "realm:hello"], "ours is higher: it says hello again, then waits to be asked");
    w.link.send({ t: "realm:need-descriptor", have: 1 });
    await until(() => w.toVerifier.length >= 4);
    assert.deepEqual(w.toVerifier.map((f) => f.t), ["realm:hello", "realm:hello", "realm:descriptor", "realm:credential"]);
    w.link.send({ t: "realm:result", ok: true, role: "member", notAfter: 5 });
    assert.deepEqual(await p, { ok: true, role: "member", notAfter: 5 });
  });
});
