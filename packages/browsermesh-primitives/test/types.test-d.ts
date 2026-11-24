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
