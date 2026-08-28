/**
 * BrowserMesh wire format type codes.
 * Ranges:
 *   0xA0–0xBF  Core mesh protocol (identity, ACL, chat, streams, naming, files, keepalive)
 *   0xC0–0xEC  Extended subsystems (swarm, audit, resources, quotas, payments, GPU, orchestration, marketplace, apps, consensus)
 *   0xED–0xEF  PBFT consensus (pre-prepare, prepare, commit)
 *   0xF0–0xF3  SWIM membership (ping, ping-req, ack, membership)
 *   0xF4–0xF5  PBFT consensus continued (view-change, new-view)
 *   0xF6–0xFF  Reserved (internal / future)
 *
 * @enum {number}
 */
export const MESH_TYPE = Object.freeze({
  /** Pod-to-pod unicast message */
  UNICAST: 0xa0,
  /** Broadcast to all connected pods */
  BROADCAST: 0xa1,
  /** Capability grant envelope */
  CAP_GRANT: 0xa2,
  /** Capability revocation */
  CAP_REVOKE: 0xa3,
  /** Trust attestation */
  TRUST_ATTEST: 0xa4,
  /** Identity announcement (join) */
  IDENTITY_ANNOUNCE: 0xa5,
  /** Identity departure (leave) */
  IDENTITY_DEPART: 0xa6,
  /** CRDT sync frame */
  CRDT_SYNC: 0xa7,
  /** Consensus proposal */
  CONSENSUS_PROPOSE: 0xa8,
  /** Consensus vote */
  CONSENSUS_VOTE: 0xa9,
  /** Resource claim */
  RESOURCE_CLAIM: 0xaa,
  /** Resource release */
  RESOURCE_RELEASE: 0xab,

  // ── ACL operations ──────────────────────────────────────────────────
  /** Grant access to identity */
  ACL_GRANT: 0xac,
  /** Revoke access */
  ACL_REVOKE: 0xad,
  /** Invitation token */
  ACL_INVITE: 0xae,

  // ── Chat protocol ───────────────────────────────────────────────────
  /** Join room */
  CHAT_JOIN: 0xb0,
  /** Leave room */
  CHAT_LEAVE: 0xb1,
  /** Typing/presence update */
  CHAT_PRESENCE: 0xb2,
  /** Moderation action */
  CHAT_MODERATE: 0xb3,

  // ── Stream operations ──────────────────────────────────────────────
  /** Named stream open request */
  STREAM_OPEN: 0xaf,

  // ── Name resolution ─────────────────────────────────────────────────
  /** Register/renew a name */
  NAME_REGISTER: 0xb5,
  /** Resolve a name query */
  NAME_RESOLVE: 0xb6,
  /** Transfer name ownership */
  NAME_TRANSFER: 0xb7,

  // ── File transfer ─────────────────────────────────────────────────
  /** Transfer offer */
  FILE_OFFER: 0xb8,
  /** Accept transfer */
  FILE_ACCEPT: 0xb9,
  /** Reject transfer */
  FILE_REJECT: 0xba,
  /** Progress update */
  FILE_PROGRESS: 0xbb,
  /** Transfer complete */
  FILE_COMPLETE: 0xbc,
  /** Cancel transfer */
  FILE_CANCEL: 0xbd,

  /** Ping / keepalive */
  PING: 0xbe,
  /** Pong / keepalive response */
  PONG: 0xbf,

  // ── Swarm coordination (0xC0–0xC3) ──────────────────────────────────
  /** Join a swarm */
  SWARM_JOIN: 0xc0,
  /** Leave a swarm */
  SWARM_LEAVE: 0xc1,
  /** Swarm heartbeat / liveness */
  SWARM_HEARTBEAT: 0xc2,
  /** Assign a task within a swarm */
  SWARM_TASK_ASSIGN: 0xc3,

  // ── Audit trail (0xC4–0xC6) ─────────────────────────────────────────
  /** Single audit log entry */
  AUDIT_ENTRY: 0xc4,
  /** Query an audit chain */
  AUDIT_CHAIN_QUERY: 0xc5,
  /** Response with audit chain data */
  AUDIT_CHAIN_RESPONSE: 0xc6,

  // ── Resource management (0xC7–0xCC) ─────────────────────────────────
  /** Advertise local resources to the mesh */
  RESOURCE_ADVERTISE: 0xc7,
  /** Discover peers matching resource constraints */
  RESOURCE_DISCOVER: 0xc8,
  /** Response to a discovery query */
  RESOURCE_DISCOVER_RESPONSE: 0xc9,
  /** Submit a compute request */
  COMPUTE_REQUEST: 0xca,
  /** Return a compute result */
  COMPUTE_RESULT: 0xcb,
  /** Incremental progress update for a running job */
  COMPUTE_PROGRESS: 0xcc,

  // ── Quota metering (0xCD–0xCF) ──────────────────────────────────────
  /** Quota rule created or updated */
  QUOTA_UPDATE: 0xcd,
  /** Quota violation detected */
  QUOTA_VIOLATION: 0xce,
  /** Periodic usage report */
  USAGE_REPORT: 0xcf,

  // ── Payment channels (0xD0–0xD3) ────────────────────────────────────
  /** Open a payment channel */
  PAYMENT_OPEN: 0xd0,
  /** Update channel balance */
  PAYMENT_UPDATE: 0xd1,
  /** Close a payment channel */
  PAYMENT_CLOSE: 0xd2,
  /** Create an escrow */
  ESCROW_CREATE: 0xd3,

  // ── GPU orchestration (0xD4–0xD7) ───────────────────────────────────
  /** GPU capability probe */
  GPU_PROBE: 0xd4,
  /** Assign a training shard to a peer */
  GPU_SHARD_ASSIGN: 0xd5,
  /** Push gradients from a shard peer */
  GPU_GRADIENT_PUSH: 0xd6,
  /** Training control message (start/cancel/status) */
  GPU_TRAIN_CONTROL: 0xd7,

  // ── Orchestration (0xD8–0xDE) ──────────────────────────────────────
  /** List all pods in the mesh */
  ORCH_LIST_PODS: 0xd8,
  /** Get detailed pod status */
  ORCH_POD_STATUS: 0xd9,
  /** Execute a command on a remote pod */
  ORCH_EXEC: 0xda,
  /** Deploy a skill to a remote pod */
  ORCH_DEPLOY: 0xdb,
  /** Drain a pod (graceful disconnect) */
  ORCH_DRAIN: 0xdc,
  /** Expose a pod's service */
  ORCH_EXPOSE: 0xdd,
  /** Route a service to a target pod */
  ORCH_ROUTE: 0xde,

  // ── Marketplace (0xDF–0xE4) ────────────────────────────────────────
  /** Publish a service listing */
  LISTING_PUBLISH: 0xdf,
  /** Query available listings */
  LISTING_QUERY: 0xe0,
  /** Response to a listing query */
  LISTING_RESPONSE: 0xe1,
  /** Purchase / subscribe to a service */
  LISTING_PURCHASE: 0xe2,
  /** Submit a review for a service */
  REVIEW_SUBMIT: 0xe3,
  /** Query reviews for a service */
  REVIEW_QUERY: 0xe4,

  // ── App distribution (0xE5–0xEA) ───────────────────────────────────
  /** App manifest announcement */
  APP_MANIFEST: 0xe5,
  /** App install request */
  APP_INSTALL: 0xe6,
  /** App uninstall request */
  APP_UNINSTALL: 0xe7,
  /** App state synchronization */
  APP_STATE_SYNC: 0xe8,
  /** App RPC call */
  APP_RPC: 0xe9,
  /** App event broadcast */
  APP_EVENT: 0xea,

  // ── Consensus extended (0xEB–0xEC) ─────────────────────────────────
  /** Close a proposal (author or timeout) */
  CONSENSUS_CLOSE: 0xeb,
  /** Broadcast final results of a closed proposal */
  CONSENSUS_RESULT: 0xec,

  // ── PBFT consensus (0xED–0xEF, 0xF4–0xF5) ────────────────────────
  /** PBFT pre-prepare (leader block proposal) */
  PBFT_PRE_PREPARE: 0xed,
  /** PBFT prepare (validator acknowledgement) */
  PBFT_PREPARE: 0xee,
  /** PBFT commit (validator commit with signature) */
  PBFT_COMMIT: 0xef,
  /** PBFT view change (leader rotation request) */
  PBFT_VIEW_CHANGE: 0xf4,
  /** PBFT new view (view change confirmation) */
  PBFT_NEW_VIEW: 0xf5,

  // ── SWIM membership (0xF0–0xF3) ──────────────────────────────────
  /** SWIM ping (failure detection) */
  SWIM_PING: 0xf0,
  /** SWIM ping-req (indirect probe) */
  SWIM_PING_REQ: 0xf1,
  /** SWIM ack (ping response) */
  SWIM_ACK: 0xf2,
  /** SWIM membership update (join/leave/suspect/faulty) */
  SWIM_MEMBERSHIP: 0xf3,
});

/**
 * Error codes for mesh protocol errors.
 *
 * @enum {number}
 */
export const MESH_ERROR = Object.freeze({
  /** Unknown or unclassified error */
  UNKNOWN: 0,
  /** Invalid wire format / decode failure */
  INVALID_FORMAT: 1,
  /** Capability check failed */
  CAPABILITY_DENIED: 2,
  /** Identity verification failed */
  IDENTITY_INVALID: 3,
  /** Trust threshold not met */
  TRUST_INSUFFICIENT: 4,
  /** Message expired (TTL exceeded) */
  MESSAGE_EXPIRED: 5,
  /** Resource unavailable */
  RESOURCE_UNAVAILABLE: 6,
  /** Consensus quorum not reached */
  QUORUM_NOT_REACHED: 7,
  /** ACL denied */
  ACL_DENIED: 8,
  /** Name already taken */
  NAME_TAKEN: 9,
  /** Name not found */
  NAME_NOT_FOUND: 10,
  /** Name expired */
  NAME_EXPIRED: 11,
  /** Room is full */
  ROOM_FULL: 12,
  /** Identity is banned */
  BANNED: 13,
  /** Stream closed */
  STREAM_CLOSED: 14,
  /** Stream limit exceeded */
  STREAM_LIMIT: 15,
  /** Transfer rejected */
  TRANSFER_REJECTED: 16,
  /** Transfer failed */
  TRANSFER_FAILED: 17,
  /** Chunk invalid */
  CHUNK_INVALID: 18,
});
