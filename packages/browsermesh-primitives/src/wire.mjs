import { MESH_TYPE } from "./constants.mjs";
import { MeshProtocolError } from "./errors.mjs";

/**
 * Registry of known mesh message types.
 * Maps type code -> human-readable name.
 *
 * @type {Map<number, string>}
 */
export const messageTypeRegistry = new Map(
  Object.entries(MESH_TYPE).map(([name, code]) => [code, name])
);

/**
 * Encode a mesh message to binary wire format.
 *
 * Format:
 * - Byte 0: message type code
 * - Bytes 1-4: payload length (big-endian uint32)
 * - Bytes 5+: JSON-encoded payload
 *
 * @param {object} message
 * @param {number} message.type - One of MESH_TYPE values
 * @param {string} message.from - Sender pod ID
 * @param {string} [message.to] - Recipient pod ID (omit for broadcast)
 * @param {*} message.payload - Message payload (must be JSON-serializable)
 * @param {number} [message.ttl] - Time-to-live in seconds
 * @returns {Uint8Array} Encoded bytes
 */
export function encodeMeshMessage(message) {
  if (!messageTypeRegistry.has(message.type)) {
    throw new MeshProtocolError(`Unknown message type: 0x${message.type.toString(16)}`);
  }
  const payload = JSON.stringify({
    from: message.from,
    to: message.to,
    payload: message.payload,
    ttl: message.ttl,
  });
  const payloadBytes = new TextEncoder().encode(payload);
  const result = new Uint8Array(5 + payloadBytes.length);
  result[0] = message.type;
  const view = new DataView(result.buffer);
  view.setUint32(1, payloadBytes.length, false); // big-endian
  result.set(payloadBytes, 5);
  return result;
}

/**
 * Decode binary wire format bytes into a mesh message object.
 *
 * @param {Uint8Array} bytes - Encoded message
 * @returns {object} Decoded message with type, from, to, payload, ttl fields
 * @throws {MeshProtocolError} If bytes are not valid mesh wire format
 */
export function decodeMeshMessage(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 5) {
    throw new MeshProtocolError('Message too short');
  }
  const type = bytes[0];
  if (!messageTypeRegistry.has(type)) {
    throw new MeshProtocolError(`Unknown message type: 0x${type.toString(16)}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const payloadLength = view.getUint32(1, false);
  if (bytes.length < 5 + payloadLength) {
    throw new MeshProtocolError(
      `Truncated message: expected ${5 + payloadLength} bytes, got ${bytes.length}`
    );
  }
  const payloadStr = new TextDecoder().decode(bytes.subarray(5, 5 + payloadLength));
  const parsed = JSON.parse(payloadStr);
  return {
    type,
    from: parsed.from,
    to: parsed.to,
    payload: parsed.payload,
    ttl: parsed.ttl,
  };
}
