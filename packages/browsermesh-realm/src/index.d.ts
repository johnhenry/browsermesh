import type { PodIdentity } from "@johnhenry/browsermesh-primitives";

/** A verdict: `{ ok: true, ...T }` or `{ ok: false, reason, detail? }`. Verifiers never throw on hostile input. */
export type Verdict<T extends object = {}> = ({ ok: true } & T) | { ok: false; reason: string; detail?: string };

/** `now` is whole seconds since the epoch, or a function returning it; default is the real clock. */
export type Clock = number | (() => number);

export class RealmError extends Error {
  readonly code: string;
  constructor(code: string, detail?: string);
}

export const DOMAINS: Readonly<{
  descriptor: string; authorityless: string; rotation: string; rotationAccept: string; credential: string; ticket: string;
}>;
export const DEFAULT_TTL: number;
export const MIN_TTL: number;
export const MAX_TTL: number;
export const DEFAULT_SKEW: number;
export const MAX_SKEW: number;
export const MAX_DESCRIPTOR_BYTES: number;
export const MAX_CREDENTIAL_BYTES: number;
export const MAX_CHAIN: number;
export const MAX_ISSUERS: number;
export const MAX_REVOKED: number;
export const GUEST_ROLE: "guest";

export function keyId(publicKey: string): Promise<string>;
export function publicKeyOf(identity: PodIdentity): Promise<string>;

// ---- roles
export function validateScope(scope: unknown): Verdict;
export function validateRoles(roles: unknown): Verdict;
export function isPrivilegedScope(scope: string): boolean;
export function defaultRole(descriptor: { mode?: string; roles?: Record<string, string[]>; defaultRole?: string }): string | null;

// ---- descriptor
export interface Rendezvous {
  signaling: string[];
  relays: string[];
  ice: { urls: string[]; username?: string; credential?: string }[];
  bootstrap: string[];
}
export interface RotationStatement {
  v: 1; realm: string; pos: number; from: string; to: string; effective: number; sig: string; countersig: string;
}
export interface RealmDescriptor {
  v: 1;
  id: string;
  name: string;
  serial: number;
  epoch: number;
  mode: "open" | "invite";
  root: { key: string; chain: RotationStatement[] };
  issuers: { key: string; notAfter: number }[];
  roles: Record<string, string[]>;
  rendezvous: Rendezvous;
  admitters: string[];
  ttl: number;
  revoked: number[];
  labels: Record<string, string>;
  extensions: Record<string, unknown>;
  updateUrl?: string;
  validUntil?: number;
  defaultRole?: string;
  sig?: string;
}
export interface DescriptorFields {
  name: string;
  roles: Record<string, string[]>;
  root: { key: string; chain?: RotationStatement[] };
  genesisKey?: string;
  serial?: number;
  epoch?: number;
  mode?: "open" | "invite";
  issuers?: { key: string; notAfter: number }[];
  rendezvous?: Rendezvous;
  admitters?: string[];
  ttl?: number;
  revoked?: number[];
  labels?: Record<string, string>;
  extensions?: Record<string, unknown>;
  updateUrl?: string;
  validUntil?: number;
  defaultRole?: string;
  maxBytes?: number;
}
export interface VerifyDescriptorOptions {
  pinnedId: string;
  now?: Clock;
  maxBytes?: number;
  maxChain?: number;
  heldChain?: RotationStatement[];
}
export type DescriptorVerdict = Verdict<{ descriptor: RealmDescriptor; text: string; chainLength: number }>;

export function checkRendezvous(r: unknown): void;
export function isStale(descriptor: { validUntil?: number }, now?: Clock): boolean;
export function createDescriptor(fields: DescriptorFields): Promise<RealmDescriptor>;
export function signDescriptor(
  descriptor: RealmDescriptor, rootIdentity: PodIdentity, opts?: { maxBytes?: number },
): Promise<{ descriptor: RealmDescriptor; text: string }>;
export function verifyDescriptor(text: unknown, opts: VerifyDescriptorOptions): Promise<DescriptorVerdict>;

export interface AuthorityLessDescriptor {
  v: 1; form: "authorityless"; id: string; name: string; mode: "open"; roles: { guest: string[] }; salt: string; hints: Rendezvous;
}
export function createAuthorityless(fields: {
  name: string; roles: { guest: string[] }; salt?: string; hints?: Rendezvous;
}): Promise<{ descriptor: AuthorityLessDescriptor; text: string }>;
export function verifyAuthorityless(
  text: unknown, opts?: { pinnedId?: string; maxBytes?: number },
): Promise<Verdict<{ descriptor: AuthorityLessDescriptor; text: string }>>;

// ---- rotation
export interface RotationBody { v?: 1; realm: string; pos: number; from: string; to: string; effective: number }
export function signRotation(body: RotationBody, outgoing: PodIdentity): Promise<string>;
export function countersignRotation(statement: RotationBody & { sig: string }, successor: PodIdentity): Promise<RotationStatement>;
export function createRotation(body: RotationBody, outgoing: PodIdentity, successor: PodIdentity): Promise<RotationStatement>;
export function verifyRotation(statement: unknown, opts?: { realm?: string }): Promise<Verdict>;
export function verifyChain(
  chain: unknown, opts: { id: string; key: string; maxChain?: number; held?: unknown[] },
): Promise<Verdict<{ rootKey: string; length: number }>>;

// ---- adoption
export function adoptDescriptor(
  held: RealmDescriptor | null | undefined,
  offered: unknown,
  opts: { pinnedId: string; now?: Clock; maxBytes?: number; maxChain?: number },
): Promise<DescriptorVerdict>;

// ---- credential
export interface CredentialFields {
  realm: string; subject: string; role: string; serial: number; notBefore: number; notAfter: number; epoch: number;
}
export interface Credential extends CredentialFields { v: 1; issuer: string; sig: string }
export type CredentialVerdict = Verdict<{
  credential: Credential;
  effective: { notBefore: number; notAfter: number };
  clamped: boolean;
  descriptorBehind: boolean;
}>;
export interface CredentialTracker {
  noteEpoch(realm: string, epoch: number): void;
  epochOf(realm: string): number | undefined;
  check(verified: CredentialVerdict, opts?: { now?: Clock }): Verdict;
  admit(verified: CredentialVerdict, opts?: { now?: Clock }): Verdict;
  readonly size: number;
}
export function createCredentialTracker(opts?: { maxEntries?: number }): CredentialTracker;
export function issueCredential(fields: CredentialFields, issuer: PodIdentity): Promise<{ credential: Credential; text: string }>;
export function verifyCredential(
  text: unknown, descriptor: RealmDescriptor, opts?: { now?: Clock; skew?: number; tracker?: CredentialTracker },
): Promise<CredentialVerdict>;
export function checkSubject(
  credential: Credential | CredentialVerdict | null | undefined, provenKey: string | Uint8Array,
): Verdict;

// ---- ledger
export interface LedgerEntry {
  readonly serial: number; readonly subject: string; readonly role: string; readonly notAfter: number; readonly state: "issued" | "revoked";
}
export interface Ledger {
  allocate(fields: { subject: string; role: string; notAfter: number }): LedgerEntry;
  get(serial: number): LedgerEntry | null;
  markRevoked(serial: number): boolean;
  list(opts?: { state?: "issued" | "revoked" }): LedgerEntry[];
  revokedSerials(opts: { now: number; max?: number; skew?: number }): number[];
  compact(opts: { now: number; skew?: number }): number;
  export(opts?: { maxBytes?: number }): string;
  readonly size: number;
  readonly nextSerial: number;
}
export function createLedger(opts?: { maxEntries?: number; serialStart?: number }): Ledger;
export function importLedger(text: string, opts?: { maxBytes?: number; maxEntries?: number }): Ledger;

// ---- realm exchange (frames, descriptor store, verifier, prover)
export const FRAME_TYPES: readonly ["realm:hello", "realm:need-descriptor", "realm:descriptor", "realm:credential", "realm:result"];
export const MAX_FRAME_BYTES: number;
export const MIN_SEAM_FRAME_BYTES: number;
export type RealmFrame =
  | { t: "realm:hello"; id: string; serial: number; epoch: number }
  | { t: "realm:need-descriptor"; have: number }
  | { t: "realm:descriptor"; text: string }
  | { t: "realm:credential"; text: string | null }
  | { t: "realm:result"; ok: boolean; reason?: string; role?: string; notAfter?: number };
export function parseFrame(raw: unknown): { ok: true; frame: RealmFrame } | { ok: false; reason: "bad-frame"; realm: boolean };

export interface DescriptorStoreLimits {
  maxBytes: number; maxOffersPerLink: number; maxVerifiesPerLink: number; maxVerifiesPerWindow: number; windowSeconds: number; maxLinks: number;
}
export interface DescriptorStore {
  readonly ready: Promise<Verdict>;
  current(): RealmDescriptor | null;
  /** The exact canonical text of the held descriptor (persist it; feed it back as `held`). */
  export(): string | null;
  offer(text: unknown, opts?: { linkId?: unknown }): Promise<Verdict<{ adopted: true; descriptor: RealmDescriptor; text: string }>>;
  onAdopt(fn: (descriptor: RealmDescriptor, previous: RealmDescriptor | null) => void): () => boolean;
  forget(linkId: unknown): void;
  stats(): { verifies: number; adopted: number; rejected: number; links: number };
}
export function createDescriptorStore(opts: {
  pinnedId: string;
  held?: string;
  heldChain?: RotationStatement[];
  now?: Clock;
  limits?: Partial<DescriptorStoreLimits>;
  onAdopt?: (descriptor: RealmDescriptor, previous: RealmDescriptor | null) => void;
}): DescriptorStore;

/** The channel shape of the admission seam's `handler` link, and of the prover's side. */
export interface RealmChannel {
  send(frame: RealmFrame | object): unknown;
  onFrame(cb: (frame: unknown) => unknown): void;
  onClose(cb: (reason?: string) => void): void;
  close(reason?: string): unknown;
}
/** What `createLinkAdmission({ handler })` passes a handler. */
export interface AdmissionLink extends RealmChannel {
  peerKey: string;
  transport: string;
  proven: boolean;
  promote(): boolean;
}
/** The two `PeerRegistry` methods the verifier uses (duck-typed: this package never imports browsermesh-apps). */
export interface RealmRegistry {
  grantRealmScopes(grant: {
    realmId: string; serial: string | number; peerKey: string; role: string; scopes: string[]; notAfter: number; epoch: number;
  }): { granted: string[]; dropped: { scope: string | null; reason: string }[] };
  revokeRealmGrants(selector: { realmId: string; peerKey?: string; serial?: string | number; belowEpoch?: number }): number;
}
export interface RealmVerifierLimits { maxFrames: number; maxDescriptorReplies: number; guestTtl: number }
export type RealmEvent =
  | { type: "refused"; peerKey: string; reason: string; detail?: string }
  | { type: "granted"; peerKey: string; role: string; serial: number; granted: string[]; dropped: { scope: string | null; reason: string }[] }
  | { type: "promoted"; peerKey: string; role: string }
  | { type: "descriptor-adopted"; serial: number; epoch: number };
export function createRealmVerifier(opts: {
  pinnedId: string;
  store: DescriptorStore;
  registry: RealmRegistry;
  now?: Clock;
  skew?: number;
  tracker?: CredentialTracker;
  limits?: Partial<RealmVerifierLimits>;
  onEvent?: (event: RealmEvent) => void;
}): { handler: (link: AdmissionLink) => Promise<void>; tracker: CredentialTracker };
export type ProverResult = { ok: true; role?: string; notAfter?: number } | { ok: false; reason: string };
export function createRealmProver(opts: {
  pinnedId: string;
  store: DescriptorStore;
  credential?: string | null;
  channel: RealmChannel;
  now?: Clock;
  timeoutMs?: number;
}): Promise<ProverResult>;
