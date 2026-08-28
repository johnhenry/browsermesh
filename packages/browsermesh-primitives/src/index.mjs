// Constants
export { MESH_TYPE, MESH_ERROR } from "./constants.mjs";

// Errors
export { MeshError, MeshProtocolError, MeshCapabilityError } from "./errors.mjs";

// Identity
export { PodIdentity, derivePodId, encodeBase64url, decodeBase64url } from "./identity.mjs";

// Wire format
export { messageTypeRegistry, encodeMeshMessage, decodeMeshMessage } from "./wire.mjs";

// Capabilities
export { parseScope, matchScope, CapabilityToken } from "./capability.mjs";

// Trust
export { TRUST_CATEGORIES, createTrustEdge, computeTransitiveTrust } from "./trust.mjs";

// ACL
export { matchResourcePattern, Permission, AccessGrant, ACLEngine, generateGrantId } from "./acl.mjs";

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
