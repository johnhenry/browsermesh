/**
 * A refusal with a status and a named reason. The reason is a short machine-readable word (it is sent to the HTTP
 * client in a header and in the audit record); the message is one plain sentence.
 */
export class IngressError extends Error {
  /**
   * @param {number} status - the HTTP status this becomes
   * @param {string} reason - `provider-pin-mismatch`, `response-too-large`, ...
   * @param {string} [message]
   * @param {object} [extra] - `{ headers }` to add to the HTTP response
   */
  constructor(status, reason, message, extra = {}) {
    super(message || reason)
    this.name = 'IngressError'
    this.status = status
    this.reason = reason
    this.headers = extra.headers
  }
}

export const REASON_HEADER = 'x-browsermesh-ingress-reason'
