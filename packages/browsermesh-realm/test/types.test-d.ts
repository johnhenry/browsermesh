// Type-checked by `npm run typecheck`, not executed.
import {
  createDescriptor, signDescriptor, verifyDescriptor, adoptDescriptor, issueCredential, verifyCredential,
  createLedger, createCredentialTracker, validateScope, checkSubject, publicKeyOf,
  type DescriptorFields, type Verdict, type RealmDescriptor, type CredentialFields,
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
