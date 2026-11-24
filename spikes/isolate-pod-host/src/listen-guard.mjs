/**
 * listen-guard.mjs -- the rule that the control routes (`routes.mjs`: spawn,
 * message, drain) are only served without a `CONTROL_TOKEN` on a loopback
 * address. Pure and import-free, so the Worker, the Node launcher
 * (`serve.mjs`) and the tests share one copy.
 */

/**
 * Whether `address` (`host`, `host:port`, `[v6]:port`) names this machine's
 * loopback and nothing else. Anything it cannot parse is not loopback.
 *
 * @param {unknown} address
 * @returns {boolean}
 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address === '') return false
  let host = address
  const bracketed = /^\[([0-9a-fA-F:.]+)\](?::\d{1,5})?$/.exec(address)
  if (bracketed) {
    host = bracketed[1]
  } else if (/^[^:]+:\d{1,5}$/.test(address)) {
    host = address.slice(0, address.lastIndexOf(':'))
  }
  if (host === 'localhost') return true
  if (host === '::1') return true
  const v4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  return v4 !== null && v4.slice(1).every((octet) => Number(octet) <= 255)
}

/**
 * @param {{address?: string, token?: string|null}} opts
 * @returns {string|null} Why the host must refuse to serve, or null. With no
 *   stated address nothing is refused: the platform (a deployed Worker) decides
 *   where it listens and its own access control applies.
 */
export function controlAuthProblem({ address, token } = {}) {
  if (address === undefined || address === null) return null
  if (isLoopbackAddress(address)) return null
  if (typeof token === 'string' && token.length > 0) return null
  return `CONTROL_TOKEN is required to serve the pod control routes on '${address}': only a loopback address may run without one`
}
