/**
 * errors.mjs -- every code this package says, in one place.
 *
 * Three lists, each exported frozen, each documented in the README (a test pins the tables to these objects):
 *   REFUSAL_CODES  what a provider answers a request with when it will not do it
 *   BUDGET_NAMES   which budget a `budget-exceeded` refusal names
 *   END_REASONS    why a connection that was open ended (audit, meter, and the error a consumer's socket fails with)
 *   LINK_CODES     what a consumer reports when there is no answer to read (the link itself failed)
 */

/** A provider's refusal codes. `message` is one plain sentence. */
export const REFUSAL_CODES = Object.freeze({
  'no-grant': 'The consumer holds no grant for this destination. Said the same whether or not the destination exists or is reachable, before any lookup.',
  'destination-refused': 'The address the destination resolves to (or is) is refused by the provider\'s address policy; `addressClass` says which kind of address.',
  'budget-exceeded': 'A budget of the provider is spent; `budget` says which.',
  'wide-not-acknowledged': 'The consumer holds a wildcard grant and the provider\'s operator has not acknowledged wide mode.',
  'chaining-refused': 'The request arrived through, or names, another egress; a provider only dials from its own network.',
  'shutting-down': 'The provider is stopping and takes no new work.',
  'port-blocked': 'The port is on the provider\'s blocked list (mail submission ports by default).',
  'bad-request': 'The request is not shaped as protocol `egress` version 1 asks.',
  'bad-destination': 'The host is not a lowercase DNS name or a canonical IPv4 dotted quad, or the port is not 1 to 65535.',
  'name-not-found': 'The name does not exist (the resolver said so).',
  'lookup-failed': 'The name could not be looked up (the resolver failed, or timed out).',
  'connect-failed': 'The connection was not made; `detail` is `refused`, `unreachable`, `timeout`, `certificate` (the server\'s certificate is not valid for the name asked for) or `failed`.',
  'bad-url': 'The URL is not an `http:` or `https:` URL this provider serves: another scheme, credentials in it, or too long.',
  'method-not-allowed': 'The method is not one this provider lets a consumer use for the fetch form (GET and HEAD unless the operator lists more).',
  'redirect-refused': 'The destination answered with a redirect this provider will not follow: the target is a destination the consumer holds no grant for, another scheme, a downgrade from https, or needs a request body to be sent again.',
  'too-many-redirects': 'The destination redirected more times than the provider follows (`limits.maxRedirects`).',
  'bad-response': 'The destination\'s answer is not one the provider will pass on: a malformed or oversized head, or too many headers.',
  'not-offered': 'This provider does not offer this form (it was given no way to make the request).',
  unknown: 'The provider refused for a reason this version does not name, or answered with something unreadable.',
})

/** The budgets a `budget-exceeded` refusal names. */
export const BUDGET_NAMES = Object.freeze({
  'connections-per-consumer': 'Open connections of this consumer are at `limits.maxConnectionsPerConsumer`.',
  'connections-global': 'Open connections of all consumers are at `limits.maxConnections`.',
  'connect-rate': 'This consumer asked for more connections in the window than `limits.connectRate` allows (refused attempts count).',
  'connect-rate-global': 'All consumers together asked for more connections in the window than `limits.globalConnectRate` allows.',
  'dns-rate': 'This consumer asked for more lookups in the window than `limits.dnsRate` allows.',
  'bytes-per-consumer': 'This consumer has moved `limits.maxBytesPerConsumer` bytes (both directions) in the window.',
  'udp-flows-per-consumer': 'Open UDP flows of this consumer are at `limits.maxUdpFlowsPerConsumer`.',
})

/** Why a connection that was open ended. `closed` is the only clean one. */
export const END_REASONS = Object.freeze({
  closed: 'Both halves finished, or the origin closed after it had finished sending.',
  revoked: 'The consumer\'s grant for this destination was revoked or expired, or its access to the protocol was.',
  shutdown: 'The provider stopped.',
  'byte-budget': 'The connection moved `limits.maxBytesPerConnection` bytes (both directions together).',
  'consumer-budget': 'The consumer reached `limits.maxBytesPerConsumer` for the window while this connection was open.',
  idle: 'Nothing moved for `limits.idleMs`.',
  'time-budget': 'The connection lived `limits.maxDurationMs`.',
  'stream-abuse': 'The consumer broke more stream rules than the provider allows, and was cut off.',
  'origin-error': 'The destination reset or failed the connection.',
  'consumer-left': 'The consumer closed or cancelled its end, or its channel closed.',
  'up-timeout': 'The consumer did not open its sending stream within `limits.upWaitMs` of the answer.',
})

/** What a consumer reports when the link, not the provider's answer, failed. */
export const LINK_CODES = Object.freeze({
  'provider-not-authorized': 'The provider has not granted this pod the `egress` protocol (`protocol:egress:open`).',
  'provider-no-egress': 'The provider does not serve the `egress` protocol.',
  'provider-version': 'The provider speaks no version of `egress` this package does.',
  'provider-timeout': 'The provider did not answer in time.',
  'provider-unreachable': 'The provider is not reachable over a direct link; routed delivery is not supported.',
  'provider-pin-mismatch': 'The channel is bound to a different pod than the one named; refused.',
  'provider-closed': 'The channel to the provider closed.',
  'provider-no-form': 'The provider does not know this form of request (it is older than the form).',
  'datagram-too-large': 'The datagram is larger than the provider\'s bound for one (`limits.maxDatagramBytes`, or the flow\'s answered bound).',
  'bad-answer': 'The provider answered with something this package cannot read.',
  'connection-ended': 'The provider ended an open connection; `reason` is one of the END_REASONS.',
  'link-closed': 'This link was closed locally.',
  'too-many-connections': 'This link already has `limits.maxConnections` connections open.',
  aborted: 'The caller\'s signal aborted the call.',
})

/** POSIX-style names a netway user or a container engine expects, for the codes that have one. */
const POSIX = Object.freeze({
  'name-not-found': 'ENOTFOUND',
  'lookup-failed': 'EAI_AGAIN',
  'destination-refused': 'EACCES',
  'no-grant': 'EACCES',
  'wide-not-acknowledged': 'EACCES',
  'port-blocked': 'EACCES',
  'chaining-refused': 'EACCES',
  'connect-failed:refused': 'ECONNREFUSED',
  'connect-failed:unreachable': 'EHOSTUNREACH',
  'connect-failed:timeout': 'ETIMEDOUT',
  'connection-ended': 'ECONNRESET',
})

/**
 * An egress failure. `code` is a REFUSAL_CODES or LINK_CODES key; the rest says more, and only what the code defines:
 * `budget` (budget-exceeded), `addressClass` (destination-refused), `detail` (connect-failed), `reason` (connection-ended).
 * `posix` is the nearest POSIX error name (`ENOTFOUND`, `ECONNREFUSED`, ...) when there is one.
 */
export class EgressError extends Error {
  /**
   * @param {string} code
   * @param {string} [message]
   * @param {{ budget?: string, addressClass?: string, detail?: string, reason?: string, cause?: unknown }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message || REFUSAL_CODES[code] || LINK_CODES[code] || code)
    this.name = 'EgressError'
    this.code = code
    if (extra.budget !== undefined) this.budget = extra.budget
    if (extra.addressClass !== undefined) this.addressClass = extra.addressClass
    if (extra.detail !== undefined) this.detail = extra.detail
    if (extra.reason !== undefined) this.reason = extra.reason
    if (extra.cause !== undefined) this.cause = extra.cause
    const posix = POSIX[code === 'connect-failed' ? `connect-failed:${extra.detail}` : code]
    if (posix) this.posix = posix
  }
}

/** The answer a provider sends for a refusal: `{ ok: false, code, ...fields }`, fields only as the code defines. */
export function refusalAnswer(code, extra = {}) {
  const out = { ok: false, code }
  if (code === 'budget-exceeded') out.budget = extra.budget
  if (code === 'destination-refused' && extra.addressClass) out.addressClass = extra.addressClass
  if (code === 'connect-failed') out.detail = extra.detail ?? 'failed'
  return out
}

const CLASS = /^[a-z-]{1,32}$/
const DETAILS = new Set(['refused', 'unreachable', 'timeout', 'certificate', 'failed'])

/** @returns {EgressError} what a consumer throws for a provider's `{ ok: false }` answer; an unreadable one is `unknown`. */
export function errorFromAnswer(answer) {
  const code = typeof answer?.code === 'string' && Object.hasOwn(REFUSAL_CODES, answer.code) ? answer.code : 'unknown'
  const extra = {}
  if (code === 'budget-exceeded' && typeof answer.budget === 'string' && Object.hasOwn(BUDGET_NAMES, answer.budget)) extra.budget = answer.budget
  if (code === 'destination-refused' && typeof answer.addressClass === 'string' && CLASS.test(answer.addressClass)) extra.addressClass = answer.addressClass
  if (code === 'connect-failed') extra.detail = DETAILS.has(answer.detail) ? answer.detail : 'failed'
  return new EgressError(code, undefined, extra)
}
