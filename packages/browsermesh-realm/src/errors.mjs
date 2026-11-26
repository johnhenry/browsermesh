import { CanonicalJsonError } from "@johnhenry/browsermesh-primitives";

/**
 * A typed failure with a stable machine `code`. Builders (`createDescriptor`, `issueCredential`, ...) throw it on bad
 * caller input; verifiers never let it escape: they turn it into `{ ok: false, reason: code, detail }`.
 */
export class RealmError extends Error {
  /**
   * @param {string} code
   * @param {string} [detail]
   */
  constructor(code, detail = code) {
    super(detail);
    this.name = "RealmError";
    this.code = code;
  }
}

export const fail = (code, detail) => {
  throw new RealmError(code, detail);
};

/** Turn any throw into a RealmError (canonical-JSON errors become `not-canonical`; anything else `malformed`). */
export function toRealmError(err) {
  if (err instanceof RealmError) return err;
  if (err instanceof CanonicalJsonError) return new RealmError("not-canonical", `${err.code}: ${err.message}`);
  return new RealmError("malformed", "unexpected input");
}

/** Run a verifier body; hostile input yields a verdict, never a throw. */
export async function guard(fn) {
  try {
    return await fn();
  } catch (err) {
    const e = toRealmError(err);
    return { ok: false, reason: e.code, detail: e.message };
  }
}

/** Run a builder body; failures surface as RealmError (with the original code) rather than raw errors. */
export async function building(fn) {
  try {
    return await fn();
  } catch (err) {
    throw toRealmError(err);
  }
}
