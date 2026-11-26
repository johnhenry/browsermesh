// Regression test for issue #181.
//
// `probeEd25519Support` is exported at runtime (src/index.mjs re-exports it
// from src/identity.mjs) but was missing from src/index.d.ts, so TypeScript
// consumers had to write a local `declare module` augmentation just to call
// it. This file is not executed — it is type-checked by `npm run typecheck`
// (see package.json / test/tsconfig.json). If `probeEd25519Support` is ever
// dropped from src/index.d.ts again, this import fails with TS2305 ("has no
// exported member").
//
// Imported by its published package name (not a relative src/ path) so the
// check also exercises the package.json `exports["."].types` resolution
// fixed in #179/#180.

import { probeEd25519Support, supportsEd25519, _resetEd25519Probe } from "@johnhenry/browsermesh-primitives";

async function checkProbeEd25519Support(): Promise<void> {
  // Real signature per src/identity.mjs: `(): Promise<boolean>`.
  const supported: boolean = await probeEd25519Support();
  void supported;
}

function checkSupportsEd25519(): void {
  // Same bug class as probeEd25519Support -- also exported from index.mjs
  // but missing from index.d.ts until this fix.
  const cached: boolean | null = supportsEd25519();
  void cached;
}

function checkResetEd25519Probe(): void {
  _resetEd25519Probe();
}

void checkProbeEd25519Support;
void checkSupportsEd25519;
void checkResetEd25519Probe;

// Session certificates and vault-friendly identity.
import {
  PodIdentity, createSession, verifyPeerCredential, MemoryRevocationStore, retireIdentity, receiveRevocation,
  podIdFromOpenSSHPublicKey, podIdToFingerprint, fingerprintToPodId, rawPublicKeyFromOpenSSH, openSSHPublicKeyFromRaw, authorizedKeysLine,
} from "@johnhenry/browsermesh-primitives";

async function checkSessions(key: Uint8Array, sign: (d: Uint8Array) => Promise<Uint8Array>): Promise<void> {
  const identity = await PodIdentity.fromSigner({ publicKey: key, sign });
  const s = await createSession(identity, { scope: ["chat:*:read"], ttlSeconds: 600 });
  const store = new MemoryRevocationStore({ maxEntries: 100 });
  store.onRevocation(({ bytes }) => void bytes);
  const peer = await verifyPeerCredential(s.certificate, { revocations: store, requireScope: "chat:a:read" });
  const scope: string[] = peer.scope;
  void scope;
  await receiveRevocation(await retireIdentity(identity), store);
  const hidden = await PodIdentity.generate({ extractable: false });
  const ext: boolean = hidden.extractable;
  void ext;
}
void checkSessions;

async function checkOpenSSH(id: PodIdentity, raw: Uint8Array): Promise<void> {
  const line: string = await id.toOpenSSHPublicKey({ comment: "pod" });
  const authorized: string = await id.toAuthorizedKeysLine({ capabilities: ["mcp:search"], expires: new Date(), comment: "pod" });
  const podId: string = await podIdFromOpenSSHPublicKey(line);
  const fingerprint: string = podIdToFingerprint(podId);
  const back: string = fingerprintToPodId(fingerprint);
  const key: Uint8Array = rawPublicKeyFromOpenSSH(openSSHPublicKeyFromRaw(raw));
  const built: string = authorizedKeysLine({ rawPublicKey: key, capabilities: [] });
  void [authorized, back, built];
}
void checkOpenSSH;

// Share code: a short code plus the fingerprint of the key that made it.
import {
  SHARE_FINGERPRINT_BITS, generateShareCode, shareFingerprintOfPodId, shareFingerprintOfPublicKey, podIdMatchesShareFingerprint,
  publicKeyMatchesShareFingerprint, normalizeShareCode, normalizeShareFingerprint, formatShare, parseShareInput, sanitizeLabel,
} from "@johnhenry/browsermesh-primitives";

async function checkShareCode(podId: string, key: Uint8Array): Promise<void> {
  const bits: number = SHARE_FINGERPRINT_BITS;
  const code: string = generateShareCode();
  const fp: string = shareFingerprintOfPodId(podId);
  const fp2: string = await shareFingerprintOfPublicKey(key);
  const same: boolean = podIdMatchesShareFingerprint(podId, fp) && (await publicKeyMatchesShareFingerprint(key, fp2));
  const n: string | null = normalizeShareCode(code) ?? normalizeShareFingerprint(fp);
  const shared = formatShare({ code, fingerprint: fp, origin: "https://app.example" });
  const parsed = parseShareInput(shared.url);
  if (parsed.ok) { const c: string = parsed.code; void c; } else { const r: "empty" | "invalid" | "no-fingerprint" | "bad-fingerprint" = parsed.reason; void r; }
  const label: string = sanitizeLabel("x", 10);
  void [bits, same, n, label];
}
void checkShareCode;

// Strict canonical JSON.
import { canonicalJson, parseCanonical, domainSigningBytes, CanonicalJsonError } from "@johnhenry/browsermesh-primitives";

const canonicalText: string = canonicalJson({ a: 1 });
const canonicalParsed = parseCanonical(canonicalText);
const canonicalBytes: Uint8Array = domainSigningBytes("d", canonicalText);
const canonicalCode: string = new CanonicalJsonError("syntax", "x").code;
void canonicalParsed;
void canonicalBytes;
void canonicalCode;
