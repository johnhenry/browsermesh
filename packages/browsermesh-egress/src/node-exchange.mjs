/**
 * node-exchange.mjs -- the fetch form's HTTP client on Node: ONE request over a socket the provider's checked `dial` made.
 *
 * This is the only file of the package that terminates TLS. The TCP form carries bytes and never sees them; the fetch form is
 * the provider acting as an HTTP client, so it sees the request and the response in the clear (`docs/design/egress.md` 4.5).
 *
 * How the connection is pinned. The name is resolved once, by the provider's `dial` (wsh's address guard): every answer is
 * classified and the socket is connected to an address that passed. This module never connects to a name. For `https:` it wraps
 * THAT socket with `tls.connect({ socket, servername })`: the handshake runs over the already connected socket, the SNI is the
 * NAME, and Node verifies the server's certificate against the name (`checkServerIdentity` with `servername`) and the
 * operator's trusted authorities. A name that resolves to a different address the second time cannot matter: there is no second
 * lookup. A certificate for another name is refused before one byte of the request is written.
 *
 * What it does not do: follow redirects (the provider does, hop by hop), decompress (`accept-encoding: identity` is sent and
 * the bytes come back as the destination sent them), keep a connection alive, or add headers beyond `host`.
 */
import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import { Readable } from 'node:stream'

const CERT_ERRORS = /^(ERR_TLS_CERT_ALTNAME_INVALID|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|CERT_[A-Z_]+|ERR_TLS_[A-Z_]+|HOSTNAME_MISMATCH|EE_KEY_TOO_SMALL|CA_MD_TOO_WEAK|ERR_SSL_[A-Z_]+)$/

const coded = (code, message, cause) => Object.assign(new Error(message), { code, ...(cause ? { cause } : {}) })

/**
 * @param {object} [opts]
 * @param {string|Buffer|Array<string|Buffer>} [opts.ca] - the certificate authorities trusted for `https:` instead of Node's own list
 *   (a private PKI, or a test's). Default: Node's bundled and system roots.
 * @returns {Function} the provider's `exchange` option
 */
export function createExchange({ ca } = {}) {
  return async function exchange({ url, method, headers, body, dial, signal, timeoutMs, maxHeaderBytes = 16 * 1024, headersTimeoutMs = 30_000 }) {
    const u = new URL(url)
    const secure = u.protocol === 'https:'
    const port = u.port === '' ? (secure ? 443 : 80) : Number(u.port)
    const host = u.hostname
    // The checked dial: resolve once, check, connect to the address that passed. Throws the address guard's own errors.
    const dialed = await dial({ host, port, signal, timeoutMs })
    let socket = dialed.socket
    socket.setNoDelay?.(true)
    const closeAll = () => { try { socket.destroy() } catch { /* closed */ } try { dialed.socket.destroy() } catch { /* closed */ } }
    if (signal?.aborted) { closeAll(); throw coded('ABORTED', 'aborted') }

    if (secure) {
      const literal = net.isIP(host)
      const secureSocket = tls.connect({
        socket, ...(literal ? { host } : { servername: host }), ...(ca ? { ca } : {}),
        rejectUnauthorized: true, ALPNProtocols: ['http/1.1'], minVersion: 'TLSv1.2',
      })
      try {
        await new Promise((resolve, reject) => {
          const onAbort = () => reject(coded('ABORTED', 'aborted'))
          signal?.addEventListener('abort', onAbort, { once: true })
          secureSocket.once('secureConnect', () => { signal?.removeEventListener('abort', onAbort); resolve() })
          secureSocket.once('error', (e) => { signal?.removeEventListener('abort', onAbort); reject(e) })
        })
        if (!secureSocket.authorized) throw coded('CERTIFICATE', 'the server certificate was not accepted')
      } catch (e) {
        closeAll()
        try { secureSocket.destroy() } catch { /* closed */ }
        if (e?.code === 'ABORTED' || e?.code === 'CERTIFICATE') throw e
        if (typeof e?.code === 'string' && CERT_ERRORS.test(e.code)) throw coded('CERTIFICATE', `the server certificate was not accepted (${e.code})`, e)
        throw coded('FAILED', String(e?.message ?? e), e)
      }
      socket = secureSocket
    }

    const path = `${u.pathname || '/'}${u.search}`
    const out = {}
    for (const [k, v] of headers) out[k] = v
    return new Promise((resolve, reject) => {
      let settled = false
      const fail = (e) => { if (settled) return; settled = true; clearTimeout(timer); closeAll(); reject(e) }
      const timer = setTimeout(() => fail(coded('TIMEOUT', 'the response head did not arrive in time')), headersTimeoutMs)
      timer.unref?.()
      const req = http.request({
        // No agent: with a `createConnection` and no agent, this request uses exactly the socket it is given and nothing else.
        createConnection: () => socket, method, path, headers: out, setHost: false,
        maxHeaderSize: maxHeaderBytes, insecureHTTPParser: false, strictContentLength: true,
      })
      const onAbort = () => { req.destroy(); fail(coded('ABORTED', 'aborted')) }
      signal?.addEventListener('abort', onAbort, { once: true })
      req.once('response', (res) => {
        if (settled) { res.destroy(); return }
        settled = true
        clearTimeout(timer)
        const pairs = []
        for (let i = 0; i < res.rawHeaders.length; i += 2) pairs.push([res.rawHeaders[i].toLowerCase(), res.rawHeaders[i + 1]])
        const destroy = () => { try { res.destroy() } catch { /* gone */ } try { req.destroy() } catch { /* gone */ } closeAll() }
        signal?.addEventListener('abort', destroy, { once: true })
        resolve({ status: res.statusCode, statusText: res.statusMessage, headers: pairs, body: res, destroy, address: dialed.address, class: dialed.class })
      })
      req.once('error', (e) => {
        if (settled) return
        const bad = e?.code === 'HPE_HEADER_OVERFLOW' || /^HPE_/.test(e?.code ?? '') || e?.code === 'ERR_HTTP_CONTENT_LENGTH_MISMATCH'
        fail(bad ? coded('BAD_RESPONSE', `the destination's answer is malformed or too large (${e.code})`, e) : e)
      })
      if (body) {
        const source = Readable.from(body, { objectMode: false })
        source.once('error', () => { try { req.destroy() } catch { /* gone */ } })
        source.pipe(req)
      } else req.end()
    })
  }
}

/** The default exchange: Node's roots. */
export const nodeExchange = createExchange()
