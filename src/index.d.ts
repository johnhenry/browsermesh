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

export declare class PodIdentity {
  keyPair: CryptoKeyPair;
  podId: string;
  constructor(opts: { keyPair: CryptoKeyPair; podId: string });
  static generate(): Promise<PodIdentity>;
  sign(data: BufferSource): Promise<Uint8Array>;
  static verify(publicKey: CryptoKey, data: BufferSource, signature: BufferSource): Promise<boolean>;
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
