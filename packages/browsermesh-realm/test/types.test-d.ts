// Type-checked by `npm run typecheck`, not executed.
import {
  createDescriptor, signDescriptor, verifyDescriptor, adoptDescriptor, issueCredential, verifyCredential,
  createLedger, createCredentialTracker, validateScope, checkSubject, publicKeyOf,
  createDescriptorStore, createRealmVerifier, createRealmProver, parseFrame,
  type DescriptorFields, type Verdict, type RealmDescriptor, type CredentialFields, type AdmissionLink, type RealmRegistry,
} from "@johnhenry/browsermesh-realm";
import type { PodIdentity } from "@johnhenry/browsermesh-primitives";

declare const root: PodIdentity;
declare const fields: DescriptorFields;
declare const cfields: CredentialFields;

async function flow(): Promise<void> {
  const d: RealmDescriptor = await createDescriptor(fields);
  const signed = await signDescriptor(d, root);
  const v = await verifyDescriptor(signed.text, { pinnedId: d.id, now: 1 });
  if (v.ok) {
    const name: string = v.descriptor.name;
    void name;
  } else {
    const why: string = v.reason;
    void why;
  }
  const a: Verdict = await adoptDescriptor(null, signed.text, { pinnedId: d.id });
  void a;
  const c = await issueCredential(cfields, root);
  const cv = await verifyCredential(c.text, d, { now: 1, skew: 300, tracker: createCredentialTracker() });
  if (cv.ok) void checkSubject(cv.credential, await publicKeyOf(root));
  const l = createLedger();
  const e = l.allocate({ subject: "k", role: "member", notAfter: 1 });
  const n: number = e.serial;
  void n;
  const s = validateScope("a:b:c");
  void s;
}
void flow;

declare const link: AdmissionLink;
declare const registry: RealmRegistry;

async function exchange(): Promise<void> {
  const store = createDescriptorStore({ pinnedId: "id", held: "{}", now: 1, limits: { maxLinks: 4 }, onAdopt: (d, prev) => void [d.serial, prev?.serial] });
  const off: () => boolean = store.onAdopt(() => {});
  void off;
  const offered = await store.offer("{}", { linkId: 1 });
  if (offered.ok) void offered.descriptor.serial;
  const verifier = createRealmVerifier({ pinnedId: "id", store, registry, now: () => 1, onEvent: (e) => void e.type });
  await verifier.handler(link);
  const result = await createRealmProver({ pinnedId: "id", store, credential: null, channel: link, timeoutMs: 100 });
  if (result.ok) void result.role;
  else {
    const why: string = result.reason;
    void why;
  }
  const parsed = parseFrame("{}");
  if (parsed.ok) void parsed.frame.t;
}
void exchange;
