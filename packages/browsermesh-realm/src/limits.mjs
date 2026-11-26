/** Caps and defaults. Everything a hostile peer can make a verifier chew on is bounded here. */
export const DAY = 86400;
export const DEFAULT_TTL = 7 * DAY;
export const MIN_TTL = 60;
export const MAX_TTL = 30 * DAY;
export const DEFAULT_SKEW = 300;
export const MAX_SKEW = 300;
export const MAX_DESCRIPTOR_BYTES = 16 * 1024;
export const MAX_CREDENTIAL_BYTES = 2 * 1024;
export const MAX_CHAIN = 8;
export const MAX_ISSUERS = 16;
export const MAX_ADMITTERS = 8;
export const MAX_REVOKED = 512;
export const MAX_ROLES = 32;
export const MAX_SCOPES_PER_ROLE = 64;
export const MAX_SCOPE_LENGTH = 256;
export const MAX_RENDEZVOUS_ENTRIES = 8;
export const MAX_LEDGER_ENTRIES = 10000;
export const MAX_LEDGER_BYTES = 2 * 1024 * 1024;
export const MAX_TRACKER_ENTRIES = 10000;
/** Largest time in whole seconds (year 9999); catches milliseconds passed by mistake. */
export const MAX_TIME = 253402300799;

export const DOMAINS = Object.freeze({
  descriptor: "browsermesh-realm/descriptor/1",
  authorityless: "browsermesh-realm/authorityless-id/1",
  rotation: "browsermesh-realm/rotation/1",
  rotationAccept: "browsermesh-realm/rotation-accept/1",
  credential: "browsermesh-realm/credential/1",
  ticket: "browsermesh-realm/ticket/1",
});
