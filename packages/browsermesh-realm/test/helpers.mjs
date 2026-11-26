// Fixed keys and fixtures. Every key derives from a fixed 32-byte seed (hex) so the vectors are reproducible.
import { PodIdentity, canonicalJson, domainSigningBytes } from "@johnhenry/browsermesh-primitives";
import { createDescriptor, signDescriptor, publicKeyOf } from "../src/index.mjs";

export const T0 = 1_800_000_000; // whole seconds
export const DAY = 86400;

const seedHex = (start) =>
  Array.from({ length: 32 }, (_, i) => ((start + i) & 0xff).toString(16).padStart(2, "0")).join("");

export const SEEDS = {
  root0: seedHex(0x00),
  root1: seedHex(0x20),
  root2: seedHex(0x40),
  rogue: seedHex(0x60),
  issuerA: seedHex(0x80),
  issuerB: seedHex(0xa0),
  alice: seedHex(0xc0),
  bob: seedHex(0xe0),
};

const PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

export async function identityFromSeed(hex) {
  const seed = Uint8Array.from(hex.match(/../g).map((h) => parseInt(h, 16)));
  const pkcs8 = new Uint8Array(PKCS8_PREFIX.length + 32);
  pkcs8.set(PKCS8_PREFIX, 0);
  pkcs8.set(seed, PKCS8_PREFIX.length);
  return PodIdentity.fromPkcs8(pkcs8, { extractable: true });
}

export const ROLES = {
  guest: ["protocol:mcp:open"],
  member: ["mcp:search:call", "objects:window:get", "protocol:mcp:open"],
};

export const RENDEZVOUS = {
  signaling: ["wss://sig.example.test/ws"],
  relays: ["wss://relay.example.test/wsh"],
  ice: [{ urls: ["stun:stun.example.test:3478"] }],
  bootstrap: ["https://boot.example.test/"],
};

/** A signed, invite-mode realm with one root (no rotation) and two issuers. */
export async function buildRealm(over = {}) {
  const root = await identityFromSeed(SEEDS.root0);
  const issuerA = await identityFromSeed(SEEDS.issuerA);
  const issuerB = await identityFromSeed(SEEDS.issuerB);
  const alice = await identityFromSeed(SEEDS.alice);
  const bob = await identityFromSeed(SEEDS.bob);
  const rootKey = await publicKeyOf(root);
  const issuerAKey = await publicKeyOf(issuerA);
  const issuerBKey = await publicKeyOf(issuerB);
  const aliceKey = await publicKeyOf(alice);
  const bobKey = await publicKeyOf(bob);
  const fields = {
    name: "test realm",
    serial: 1,
    epoch: 0,
    mode: "invite",
    root: { key: rootKey, chain: [] },
    issuers: [
      { key: issuerAKey, notAfter: T0 + 90 * DAY },
      { key: issuerBKey, notAfter: T0 + 90 * DAY },
    ],
    roles: ROLES,
    rendezvous: RENDEZVOUS,
    ttl: 7 * DAY,
    ...over,
  };
  const descriptor = await createDescriptor(fields);
  const signed = await signDescriptor(descriptor, root);
  return {
    root, issuerA, issuerB, alice, bob,
    rootKey, issuerAKey, issuerBKey, aliceKey, bobKey,
    fields, descriptor: signed.descriptor, text: signed.text, id: signed.descriptor.id,
  };
}

/** Sign canonical(body) under an arbitrary domain, bypassing every guard (for forging in tests). */
export async function rawSign(identity, domain, body) {
  const sig = await identity.sign(domainSigningBytes(domain, canonicalJson(body)));
  return Buffer.from(sig).toString("base64url");
}
