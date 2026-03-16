import { MESH_ERROR } from "./constants.mjs";

/**
 * Base error class for all BrowserMesh errors.
 */
export class MeshError extends Error {
  /**
   * @param {string} message
   * @param {number} [code=MESH_ERROR.UNKNOWN]
   */
  constructor(message, code = MESH_ERROR.UNKNOWN) {
    super(message);
    this.name = "MeshError";
    this.code = code;
  }
}

/**
 * Wire-format or protocol-level error.
 */
export class MeshProtocolError extends MeshError {
  /**
   * @param {string} message
   * @param {number} [code=MESH_ERROR.INVALID_FORMAT]
   */
  constructor(message, code = MESH_ERROR.INVALID_FORMAT) {
    super(message, code);
    this.name = "MeshProtocolError";
  }
}

/**
 * Capability check failure.
 */
export class MeshCapabilityError extends MeshError {
  /**
   * @param {string} message
   * @param {string} [requiredScope]
   */
  constructor(message, requiredScope) {
    super(message, MESH_ERROR.CAPABILITY_DENIED);
    this.name = "MeshCapabilityError";
    /** @type {string|undefined} */
    this.requiredScope = requiredScope;
  }
}
