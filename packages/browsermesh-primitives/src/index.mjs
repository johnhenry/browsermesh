// Constants
export { MESH_TYPE, MESH_ERROR } from "./constants.mjs";

// Errors
export { MeshError, MeshProtocolError, MeshCapabilityError } from "./errors.mjs";

// Identity
export { PodIdentity, derivePodId, encodeBase64url, decodeBase64url, supportsEd25519, probeEd25519Support, _resetEd25519Probe } from "./identity.mjs";

// One key in two worlds: pod id <-> wsh fingerprint, and OpenSSH public key lines (explicit, never automatic)
export {
  podIdToFingerprint,
  fingerprintToPodId,
  openSSHPublicKeyFromRaw,
  rawPublicKeyFromOpenSSH,
  podIdFromOpenSSHPublicKey,
  authorizedKeysLine,
} from "./ssh-keys.mjs";

// Share code: a short code plus the fingerprint of the key that made it, and label sanitising
export {
  SHARE_CODE_CHARS,
  SHARE_FINGERPRINT_CHARS,
  SHARE_FINGERPRINT_BITS,
  MAX_LABEL_CHARS,
  generateShareCode,
  shareFingerprintOfPodId,
  shareFingerprintOfPublicKey,
  podIdMatchesShareFingerprint,
  publicKeyMatchesShareFingerprint,
  normalizeShareCode,
  normalizeShareFingerprint,
  formatShareCode,
  formatShareFingerprint,
  formatShare,
  parseShareInput,
  sanitizeLabel,
} from "./share-code.mjs";

// Session certificates and signed revocation
export {
  CERT_VERSION,
  DEFAULT_MAX_LIFETIME_SECONDS,
  DEFAULT_SKEW_SECONDS,
  MAX_SKEW_SECONDS,
  MAX_SCOPE_ENTRIES,
  MAX_SCOPE_ENTRY_BYTES,
  DEFAULT_REVOCATION_STORE_SIZE,
  REVOCATION_KIND,
  CredentialError,
  verifyWithRawPublicKey,
  podIdFromRawKey,
  encodeSessionCertificateBody,
  decodeSessionCertificate,
  issueSessionCertificate,
  createSession,
  createSessionProof,
  scopeAllows,
  verifyPeerCredential,
  revokeSessionCertificate,
  retireIdentity,
  verifyRevocation,
  receiveRevocation,
  isRevoked,
  MemoryRevocationStore,
} from "./session.mjs";

// Key agreement keys bound to pod ids, and sealing to them
export {
  KeyAgreementError,
  KEY_STATEMENT_VERSION,
  MAX_STATEMENT_LIFETIME_MS,
  DEFAULT_STATEMENT_LIFETIME_MS,
  DEFAULT_MAX_SEALED_BYTES,
  supportsKeyAgreement,
  generateAgreementKeyPair,
  keyIdOf,
  createKeyStatement,
  verifyKeyStatement,
  sealToStatement,
  openSealed,
} from "./key-agreement.mjs";

// Wire format
export { messageTypeRegistry, encodeMeshMessage, decodeMeshMessage } from "./wire.mjs";

// Capabilities
export { parseScope, matchScope, CapabilityToken } from "./capability.mjs";

// Trust
export { TRUST_CATEGORIES, createTrustEdge, computeTransitiveTrust } from "./trust.mjs";

// ACL
export { matchResourcePattern, Permission, AccessGrant, ACLEngine, generateGrantId, grantFromToken } from "./acl.mjs";

// CRDTs
export { VectorClock, LWWRegister, GCounter, PNCounter, ORSet, RGA, LWWMap } from "./crdt.mjs";

// Test transport
export {
  DeterministicRNG,
  LocalChannel,
  createLocalChannelPair,
  TestMesh,
  TESTMESH_LIMITS,
} from "./test-transport.mjs";

// Size-bucket padding (relay-blind envelopes)
export { DEFAULT_PAD_BUCKETS, PAD_TRAILER_BYTES, paddedLength, padTo, unpad } from "./padding.mjs";

// Mesh addressing
export { parseMeshRequest } from './mesh-address.mjs';

// Strict canonical JSON (realm descriptors and credentials)
export { canonicalJson, parseCanonical, domainSigningBytes, CanonicalJsonError, CANONICAL_MAX_INTEGER } from "./canonical-json.mjs";
