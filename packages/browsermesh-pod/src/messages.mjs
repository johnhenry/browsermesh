/**
 * messages.mjs — Pod wire protocol message types and factories.
 *
 * Defines the message constants and factory functions used for pod
 * discovery, handshake, and inter-pod communication.
 */

// ── Message type constants ──────────────────────────────────────

export const POD_HELLO = 'pod:hello'
export const POD_HELLO_ACK = 'pod:hello-ack'
export const POD_GOODBYE = 'pod:goodbye'
export const POD_MESSAGE = 'pod:message'
export const POD_RPC_REQUEST = 'pod:rpc-request'
export const POD_RPC_RESPONSE = 'pod:rpc-response'

// ── Message factories ───────────────────────────────────────────

/**
 * Create a HELLO message for discovery / parent handshake.
 *
 * @param {object} opts
 * @param {string} opts.podId - Sender's pod ID
 * @param {string} opts.kind - Sender's pod kind
 * @param {object} [opts.capabilities] - Sender's capabilities snapshot
 * @returns {object}
 */
export function createHello({ podId, kind, capabilities }) {
  return {
    type: POD_HELLO,
    podId,
    kind,
    capabilities: capabilities || null,
    ts: Date.now(),
  }
}

/**
 * Create a HELLO_ACK response.
 *
 * @param {object} opts
 * @param {string} opts.podId - Responder's pod ID
 * @param {string} opts.kind - Responder's pod kind
 * @param {string} opts.targetPodId - Original sender's pod ID
 * @returns {object}
 */
export function createHelloAck({ podId, kind, targetPodId }) {
  return {
    type: POD_HELLO_ACK,
    podId,
    kind,
    targetPodId,
    ts: Date.now(),
  }
}

/**
 * Create a GOODBYE message (graceful shutdown announcement).
 *
 * @param {object} opts
 * @param {string} opts.podId - Departing pod's ID
 * @returns {object}
 */
export function createGoodbye({ podId }) {
  return {
    type: POD_GOODBYE,
    podId,
    ts: Date.now(),
  }
}

/**
 * Create a generic inter-pod message.
 *
 * @param {object} opts
 * @param {string} opts.from - Sender pod ID
 * @param {string} opts.to - Target pod ID (or '*' for broadcast)
 * @param {*} opts.payload - Message payload
 * @returns {object}
 */
export function createMessage({ from, to, payload }) {
  return {
    type: POD_MESSAGE,
    from,
    to,
    payload,
    ts: Date.now(),
  }
}

/**
 * Create an RPC request message.
 *
 * @param {object} opts
 * @param {string} opts.from - Sender pod ID
 * @param {string} opts.to - Target pod ID
 * @param {string} opts.method - RPC method name
 * @param {*} [opts.params] - Method parameters
 * @param {string} opts.requestId - Unique request identifier
 * @returns {object}
 */
export function createRpcRequest({ from, to, method, params, requestId }) {
  return {
    type: POD_RPC_REQUEST,
    from,
    to,
    method,
    params: params ?? null,
    requestId,
    ts: Date.now(),
  }
}

/**
 * Create an RPC response message.
 *
 * @param {object} opts
 * @param {string} opts.from - Responder pod ID
 * @param {string} opts.to - Original requester pod ID
 * @param {string} opts.requestId - Matching request identifier
 * @param {*} [opts.result] - Success result
 * @param {string} [opts.error] - Error message if failed
 * @returns {object}
 */
export function createRpcResponse({ from, to, requestId, result, error }) {
  return {
    type: POD_RPC_RESPONSE,
    from,
    to,
    requestId,
    result: result ?? null,
    error: error ?? null,
    ts: Date.now(),
  }
}
