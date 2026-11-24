// Type definitions for mesh-primitives

export declare const MESH_TYPE: Readonly<Record<string, number>>;
export declare const MESH_ERROR: Readonly<Record<string, number>>;

export declare class MeshError extends Error {
  code: number;
  constructor(message: string, code?: number);
}
export declare class MeshProtocolError extends MeshError {
  constructor(message: string, code?: number);
}
export declare class MeshCapabilityError extends MeshError {
  requiredScope?: string;
  constructor(message: string, requiredScope?: string);
}

export declare function encodeBase64url(bytes: Uint8Array): string;
export declare function decodeBase64url(str: string): Uint8Array;
export declare function derivePodId(publicKey: CryptoKey): Promise<string>;

/**
 * Probe for WebCrypto Ed25519 support by asking for a key. Resolves true or
 * false, never throws, and caches the answer. Call this before
 * `PodIdentity.generate()` if you need to degrade gracefully rather than
 * catch a NotSupportedError from four frames down.
 */
export declare function probeEd25519Support(): Promise<boolean>;

/**
 * Cached answer from `probeEd25519Support()`, or `null` when the probe has
 * not resolved yet. Treat `null` as "unknown"; await `probeEd25519Support()`
 * for a definite answer.
 */
export declare function supportsEd25519(): boolean | null;

/** Reset the cached Ed25519 probe. Tests only. */
export declare function _resetEd25519Probe(): void;

/**
 * An external signer: `@johnhenry/wsh`'s "page-held signer" shape. `publicKey`
 * is the raw 32-byte Ed25519 key or a public `CryptoKey`; `sign` returns the
 * 64-byte signature, sync or async.
 */
export interface Ed25519Signer {
  publicKey: Uint8Array | CryptoKey;
  sign(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

export declare class PodIdentity {
  /** For a signer identity `privateKey` is `null`. */
  keyPair: CryptoKeyPair;
  podId: string;
  constructor(opts: { keyPair: CryptoKeyPair; podId: string; signer?: (data: BufferSource) => Uint8Array | Promise<Uint8Array> });
  /** Private key is extractable by default; pass `{ extractable: false }` for a key this page cannot read. */
  static generate(opts?: { extractable?: boolean }): Promise<PodIdentity>;
  static fromCryptoKeyPair(keyPair: CryptoKeyPair): Promise<PodIdentity>;
  static fromJwk(jwk: object, opts?: { extractable?: boolean }): Promise<PodIdentity>;
  static fromPkcs8(pkcs8: BufferSource, opts?: { extractable?: boolean; publicKey?: Uint8Array | CryptoKey }): Promise<PodIdentity>;
  static fromSigner(signer: Ed25519Signer, opts?: { check?: boolean }): Promise<PodIdentity>;
  /** True when the private key is an extractable CryptoKey this object holds. */
  readonly extractable: boolean;
  /** True when signing goes to an external signer. */
  readonly isExternalSigner: boolean;
  /** Raw 32-byte public key (public key export only). */
  rawPublicKey(): Promise<Uint8Array>;
  /** The public key as an OpenSSH line (`ssh-ed25519 AAAA...`). Explicit; nothing calls it by default. */
  toOpenSSHPublicKey(opts?: { comment?: string }): Promise<string>;
  /** A wsh / OpenSSH authorized_keys line (`capabilities="..."` is required, even empty). Explicit; see docs/security.md "One key in both worlds". */
  toAuthorizedKeysLine(opts: { capabilities: string[]; expires?: Date | number | string; comment?: string }): Promise<string>;
  /** Rejects unless the identity is exportable. */
  exportPrivateKey(format?: 'jwk' | 'pkcs8'): Promise<object | Uint8Array>;
  sign(data: BufferSource): Promise<Uint8Array>;
  /**
   * Argument order is (publicKey, signature, data), matching WebCrypto.
   * BREAKING in 0.2.0: previously (publicKey, data, signature). Throws a
   * TypeError if the old order is detected (64-byte data, non-64-byte signature).
   */
  static verify(publicKey: CryptoKey, signature: BufferSource, data: BufferSource): Promise<boolean>;
}

// ---- Session certificates and signed revocation ----

export declare const CERT_VERSION: 1;
export declare const DEFAULT_MAX_LIFETIME_SECONDS: number;
export declare const DEFAULT_SKEW_SECONDS: number;
export declare const MAX_SKEW_SECONDS: number;
export declare const MAX_SCOPE_ENTRIES: number;
export declare const MAX_SCOPE_ENTRY_BYTES: number;
export declare const DEFAULT_REVOCATION_STORE_SIZE: number;
export declare const REVOCATION_KIND: Readonly<{ SESSION: 1; IDENTITY: 2 }>;

export declare class CredentialError extends Error {
  /** malformed | unsupported-version | bad-signature | not-yet-valid | expired | invalid-lifetime | lifetime-too-long | chain-too-long | revoked | identity-retired | wrong-identity | scope-denied | bad-proof | bad-argument | store-full */
  code: string;
  constructor(code: string, message: string);
}

export interface SessionCertificateFields {
  identityKey: Uint8Array;
  sessionKey: Uint8Array;
  serial: Uint8Array;
  notBefore: number;
  notAfter: number;
  scope: string[];
}
export interface DecodedSessionCertificate extends SessionCertificateFields {
  version: number;
  signature: Uint8Array;
  body: Uint8Array;
}
export interface IssuedSessionCertificate {
  certificate: Uint8Array;
  serial: string;
  identityKey: Uint8Array;
  sessionKey: Uint8Array;
  scope: string[];
  notBefore: number;
  notAfter: number;
}
export interface IssueOptions {
  scope: string[];
  ttlSeconds?: number;
  notBefore?: number;
  notAfter?: number;
  serial?: Uint8Array;
  now?: number | Date;
  maxLifetimeSeconds?: number;
}
export interface PeerCredential {
  identityKey: Uint8Array;
  podId: string;
  sessionKey: Uint8Array;
  scope: string[];
  serial: string;
  notBefore: number;
  notAfter: number;
}
export interface RevocationStatement {
  kind: number;
  identityKey: Uint8Array;
  serial: Uint8Array;
  issuedAt: number;
  retainUntil: number;
  bytes: Uint8Array;
}
export interface RevocationStore {
  add(statement: RevocationStatement, bytes: Uint8Array): boolean | 'ignored' | Promise<boolean | 'ignored'>;
  isRevoked(identityKey: Uint8Array, serial: Uint8Array | null): boolean | Promise<boolean>;
}

export declare function verifyWithRawPublicKey(rawPublicKey: Uint8Array, signature: Uint8Array, data: BufferSource): Promise<boolean>;
export declare function podIdFromRawKey(rawPublicKey: Uint8Array): Promise<string>;
/** pod id (base64url SHA-256 of the raw key) to wsh's fingerprint (the same hash in hex). Strict: 32 bytes. */
export declare function podIdToFingerprint(podId: string): string;
export declare function fingerprintToPodId(fingerprint: string): string;
/** `ssh-ed25519 AAAA...` for a raw 32-byte key. */
export declare function openSSHPublicKeyFromRaw(rawPublicKey: Uint8Array, opts?: { comment?: string }): string;
/** The raw key of an `ssh-ed25519` public key line; refuses options, other key types and non-canonical encodings. */
export declare function rawPublicKeyFromOpenSSH(line: string): Uint8Array;
export declare function podIdFromOpenSSHPublicKey(line: string): Promise<string>;
export declare function authorizedKeysLine(opts: { rawPublicKey: Uint8Array; capabilities: string[]; expires?: Date | number | string; comment?: string }): string;
export declare function encodeSessionCertificateBody(c: SessionCertificateFields): Uint8Array;
export declare function decodeSessionCertificate(credential: Uint8Array | string): DecodedSessionCertificate;
export declare function issueSessionCertificate(identity: PodIdentity, opts: IssueOptions & { sessionPublicKey: Uint8Array | CryptoKey }): Promise<IssuedSessionCertificate>;
export declare function createSession(identity: PodIdentity, opts: IssueOptions): Promise<IssuedSessionCertificate & { session: PodIdentity }>;
export declare function createSessionProof(session: PodIdentity, challenge: Uint8Array): Promise<Uint8Array>;
export declare function scopeAllows(scope: string[], required: string): boolean;
export declare function verifyPeerCredential(
  credential: Uint8Array | string | Array<Uint8Array | string>,
  opts?: {
    now?: number | Date;
    skewSeconds?: number;
    maxLifetimeSeconds?: number;
    revocations?: RevocationStore;
    expectedIdentity?: Uint8Array | string;
    requireScope?: string;
    proof?: { challenge: Uint8Array; signature: Uint8Array };
  }
): Promise<PeerCredential>;
export declare function revokeSessionCertificate(identity: PodIdentity, certificate: Uint8Array | string, opts?: { now?: number | Date }): Promise<Uint8Array>;
export declare function retireIdentity(identity: PodIdentity, opts?: { now?: number | Date }): Promise<Uint8Array>;
export declare function verifyRevocation(bytes: Uint8Array | string): Promise<RevocationStatement>;
export declare function receiveRevocation(bytes: Uint8Array | string, store: RevocationStore): Promise<{ status: 'added' | 'duplicate' | 'ignored'; statement: RevocationStatement; bytes: Uint8Array }>;
export declare function isRevoked(subject: { identityKey: Uint8Array; serial?: Uint8Array | null }, store: RevocationStore): Promise<boolean>;
export declare class MemoryRevocationStore implements RevocationStore {
  constructor(opts?: { maxEntries?: number; filter?: (statement: RevocationStatement) => boolean; clock?: () => number });
  clock: () => number;
  readonly size: number;
  prune(now?: number | Date): number;
  add(statement: RevocationStatement, bytes: Uint8Array): boolean | 'ignored';
  isRevoked(identityKey: Uint8Array, serial: Uint8Array | null): boolean;
  list(): Uint8Array[];
  onRevocation(fn: (ev: { statement: RevocationStatement; bytes: Uint8Array }) => void): () => void;
}

export declare const messageTypeRegistry: Map<number, string>;
export declare function encodeMeshMessage(message: {
  type: number;
  from: string;
  to?: string;
  payload: unknown;
  ttl?: number;
}): Uint8Array;
export declare function decodeMeshMessage(bytes: Uint8Array): {
  type: number;
  from: string;
  to?: string;
  payload: unknown;
  ttl?: number;
};

export declare function parseScope(scope: string): {
  namespace: string;
  resource: string;
  action: string;
};
export declare function matchScope(granted: string, required: string): boolean;

export declare class CapabilityToken {
  issuer: string;
  subject: string;
  scopes: string[];
  expiresAt: number;
  signature?: Uint8Array;
  constructor(opts: {
    issuer: string;
    subject: string;
    scopes: string[];
    expiresAt: number;
    signature?: Uint8Array;
  });
  isExpired(now?: number): boolean;
  covers(scope: string): boolean;
  toJSON(): {
    issuer: string;
    subject: string;
    scopes: string[];
    expiresAt: number;
  };
}

export declare const TRUST_CATEGORIES: Readonly<{
  DIRECT: "direct";
  TRANSITIVE: "transitive";
  MEMBERSHIP: "membership";
  REPUTATION: "reputation";
}>;

export interface TrustEdge {
  from: string;
  to: string;
  category: string;
  value: number;
  timestamp: number;
}
export declare function createTrustEdge(opts: {
  from: string;
  to: string;
  category: string;
  value: number;
  timestamp?: number;
}): TrustEdge;
export declare function computeTransitiveTrust(
  edges: TrustEdge[],
  source: string,
  target: string,
  maxDepth?: number
): number;

// ACL

export declare function matchResourcePattern(pattern: string, resource: string): boolean;

export interface PermissionQuotas {
  maxCalls?: number;
  maxBytes?: number;
  maxTokens?: number;
  maxConcurrent?: number;
}

export declare class Permission {
  resource: string;
  actions: string[];
  quotas: PermissionQuotas | null;
  constructor(opts: {
    resource: string;
    actions: string[];
    quotas?: PermissionQuotas | null;
  });
  matches(resource: string, action: string): boolean;
  toJSON(): {
    resource: string;
    actions: string[];
    quotas: PermissionQuotas | null;
  };
  static fromJSON(data: {
    resource: string;
    actions: string[];
    quotas?: PermissionQuotas | null;
  }): Permission;
}

export interface TimeWindow {
  start: string;
  end: string;
}

export interface GrantConditions {
  expires?: number;
  maxUses?: number;
  timeWindows?: TimeWindow[];
}

export interface CheckResult {
  allowed: boolean;
  grant?: AccessGrant;
  reason?: string;
}

export declare class AccessGrant {
  id: string;
  grantee: string;
  grantor: string;
  permissions: Permission[];
  conditions: GrantConditions;
  created: number;
  revoked: number | null;
  usageCount: number;
  constructor(opts: {
    id: string;
    grantee: string;
    grantor: string;
    permissions: Array<Permission | {
      resource: string;
      actions: string[];
      quotas?: PermissionQuotas | null;
    }>;
    conditions?: GrantConditions;
    created?: number;
    usageCount?: number;
  });
  isExpired(now?: number): boolean;
  isRevoked(): boolean;
  isWithinTimeWindow(now?: Date): boolean;
  check(resource: string, action: string, now?: number): CheckResult;
  consumeUse(): void;
  revoke(timestamp?: number): void;
  toJSON(): {
    id: string;
    grantee: string;
    grantor: string;
    permissions: Array<{
      resource: string;
      actions: string[];
      quotas: PermissionQuotas | null;
    }>;
    conditions: GrantConditions;
    created: number;
    revoked: number | null;
    usageCount: number;
  };
  static fromJSON(data: {
    id: string;
    grantee: string;
    grantor: string;
    permissions: Array<{
      resource: string;
      actions: string[];
      quotas?: PermissionQuotas | null;
    }>;
    conditions?: GrantConditions;
    created: number;
    revoked?: number | null;
    usageCount?: number;
  }): AccessGrant;
}

export interface GranteeInfo {
  grantee: string;
  count: number;
}

export declare class ACLEngine {
  constructor();
  addGrant(grant: AccessGrant): void;
  removeGrant(grantId: string): boolean;
  revokeGrant(grantId: string, timestamp?: number): boolean;
  revokeAll(grantee: string, timestamp?: number): number;
  check(grantee: string, resource: string, action: string, now?: number): CheckResult;
  listGrants(grantee?: string): AccessGrant[];
  listGrantees(): GranteeInfo[];
  getEffectivePermissions(grantee: string, now?: number): Permission[];
  pruneExpired(now?: number): number;
  toJSON(): { grants: Array<ReturnType<AccessGrant['toJSON']>> };
  static fromJSON(data: { grants: Array<Parameters<typeof AccessGrant.fromJSON>[0]> }): ACLEngine;
  get size(): number;
}

export declare function generateGrantId(): string;

export declare function grantFromToken(
  token: { issuer: string; subject: string; scopes: string[]; expiresAt: number },
  opts?: { grantor?: string; id?: string; created?: number }
): AccessGrant;

// CRDTs

export declare class VectorClock {
  constructor(entries?: Map<string, number>);
  increment(nodeId: string): VectorClock;
  get(nodeId: string): number;
  merge(other: VectorClock): VectorClock;
  compare(other: VectorClock): 'before' | 'after' | 'concurrent' | 'equal';
  toJSON(): Record<string, number>;
  static fromJSON(data: Record<string, number>): VectorClock;
}

export declare class LWWRegister<T = unknown> {
  constructor(value?: T | null, timestamp?: number, nodeId?: string);
  get value(): T | null;
  set(value: T, timestamp: number, nodeId: string): void;
  merge(other: LWWRegister<T>): LWWRegister<T>;
  state(): { value: T | null; timestamp: number; nodeId: string };
  toJSON(): { value: T | null; timestamp: number; nodeId: string };
  static fromJSON<T>(data: { value: T | null; timestamp: number; nodeId: string }): LWWRegister<T>;
}

export declare class GCounter {
  constructor(counts?: Map<string, number>);
  get value(): number;
  increment(nodeId: string, amount?: number): void;
  merge(other: GCounter): GCounter;
  state(): Map<string, number>;
  toJSON(): Record<string, number>;
  static fromJSON(data: Record<string, number>): GCounter;
}

export declare class PNCounter {
  constructor(pos?: GCounter, neg?: GCounter);
  get value(): number;
  increment(nodeId: string, amount?: number): void;
  decrement(nodeId: string, amount?: number): void;
  merge(other: PNCounter): PNCounter;
  state(): { pos: GCounter; neg: GCounter };
  toJSON(): { pos: Record<string, number>; neg: Record<string, number> };
  static fromJSON(data: { pos: Record<string, number>; neg: Record<string, number> }): PNCounter;
}

export declare class ORSet<T = unknown> {
  constructor();
  get value(): Set<T>;
  add(element: T, nodeId: string): void;
  remove(element: T): void;
  has(element: T): boolean;
  merge(other: ORSet<T>): ORSet<T>;
  state(): { elements: Map<T, Set<string>>; tombstones: Set<string> };
  toJSON(): {
    elements: Array<{ element: T; tags: string[] }>;
    tombstones: string[];
  };
  static fromJSON<T>(data: {
    elements: Array<{ element: T; tags: string[] }>;
    tombstones: string[];
  }): ORSet<T>;
}

export interface RGANode<T = unknown> {
  id: string;
  value: T;
  deleted: boolean;
}

export declare class RGA<T = unknown> {
  constructor();
  get value(): T[];
  get length(): number;
  insertAt(index: number, value: T, nodeId: string): void;
  deleteAt(index: number): void;
  merge(other: RGA<T>): RGA<T>;
  state(): { nodes: RGANode<T>[]; vclock: VectorClock };
  toJSON(): { nodes: RGANode<T>[]; vclock: Record<string, number> };
  static fromJSON<T>(data: {
    nodes: RGANode<T>[];
    vclock: Record<string, number>;
  }): RGA<T>;
}

export declare class LWWMap<T = unknown> {
  constructor();
  get value(): Record<string, T>;
  get size(): number;
  set(key: string, value: T, timestamp: number, nodeId: string): void;
  delete(key: string, timestamp: number, nodeId: string): void;
  get(key: string): T | undefined;
  has(key: string): boolean;
  merge(other: LWWMap<T>): LWWMap<T>;
  keys(): IterableIterator<string>;
  values(): IterableIterator<T>;
  entries(): IterableIterator<[string, T]>;
  state(): Map<string, LWWRegister<T>>;
  toJSON(): {
    entries: Record<string, {
      value: T | null;
      timestamp: number;
      nodeId: string;
      tombstone: boolean;
    }>;
  };
  static fromJSON<T>(data: {
    entries: Record<string, {
      value: T | null;
      timestamp: number;
      nodeId: string;
      tombstone?: boolean;
    }>;
  }): LWWMap<T>;
}

// Size-bucket padding

export declare const DEFAULT_PAD_BUCKETS: readonly number[];
export declare const PAD_TRAILER_BYTES: 4;
export declare function paddedLength(length: number, opts?: { buckets?: number[] }): number;
export declare function padTo(bytes: Uint8Array, opts?: { buckets?: number[] }): Uint8Array;
export declare function unpad(padded: Uint8Array): Uint8Array;

// Key agreement keys bound to pod ids, and sealing to them

export declare class KeyAgreementError extends Error {
  code: 'malformed' | 'unsupported-version' | 'pod-id-mismatch' | 'bad-signature' | 'not-yet-valid' | 'expired' | 'invalid-lifetime' | 'lifetime-too-long' | 'wrong-identity' | 'identity-retired' | 'unknown-key' | 'open-failed' | 'too-large' | 'bad-argument' | 'unsupported';
}
export declare const KEY_STATEMENT_VERSION: 1;
export declare const MAX_STATEMENT_LIFETIME_MS: number;
export declare const DEFAULT_STATEMENT_LIFETIME_MS: number;
export declare const DEFAULT_MAX_SEALED_BYTES: number;
export interface AgreementKeyPair { privateKey: CryptoKey; publicKeyRaw: Uint8Array }
export interface KeyStatement { v: 1; podId: string; pk: string; ka: string; kid: string; notBefore: number; notAfter: number; sig: string }
export interface VerifiedKeyStatement { podId: string; pk: Uint8Array; ka: Uint8Array; kid: string; notBefore: number; notAfter: number }
export interface SealedBox { v: 1; kid: string; epk: string; iv: string; ct: string }
export declare function supportsKeyAgreement(): Promise<boolean>;
export declare function generateAgreementKeyPair(): Promise<AgreementKeyPair>;
export declare function keyIdOf(ka: Uint8Array): Promise<string>;
export declare function createKeyStatement(identity: { podId: string; sign(data: Uint8Array): Promise<Uint8Array> | Uint8Array; rawPublicKey(): Promise<Uint8Array> }, agreement: { publicKeyRaw: Uint8Array }, opts?: { now?: number; lifetimeMs?: number }): Promise<KeyStatement>;
export declare function verifyKeyStatement(statement: unknown, opts?: { now?: number; skewMs?: number; expectedPodId?: string; revocations?: { isRevoked(identityKey: Uint8Array, serial: Uint8Array | null): boolean | Promise<boolean> } }): Promise<VerifiedKeyStatement>;
export declare function sealToStatement(verified: { ka: Uint8Array; kid: string }, opts: { aad: Uint8Array; plaintext: Uint8Array; maxBytes?: number }): Promise<SealedBox>;
export declare function openSealed(sealed: unknown, opts: { privateKeys: Map<string, AgreementKeyPair> | ((kid: string) => AgreementKeyPair | undefined); aad: Uint8Array; maxBytes?: number }): Promise<Uint8Array>;

/** Parse a case-sensitive mesh:// or *.mesh.local address. */
export declare function parseMeshRequest(url: string): { podId: string; path: string } | null;
