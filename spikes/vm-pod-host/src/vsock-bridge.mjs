/**
 * vsock-bridge.mjs — host-side helpers for Firecracker's vsock Unix
 * Domain Socket protocol (docs/vsock.md on the Firecracker `main` branch,
 * fetched 2026-09-30).
 *
 * Firecracker exposes a single virtio-vsock device per microVM. The host
 * never talks AF_VSOCK directly — it talks to the device's `uds_path`
 * (a plain AF_UNIX socket, set via `FirecrackerClient#putVsock`) and
 * Firecracker proxies frames to/from the guest's AF_VSOCK sockets.
 *
 * Two independent directions, two different wire conventions:
 *
 *  1. Host → guest (host connects out to a guest-listening port):
 *     - Host opens a connection to `uds_path`.
 *     - Host writes the ASCII line `CONNECT <port>\n`.
 *     - On success Firecracker replies `OK <assigned_hostside_port>\n`
 *       and the socket is now a raw byte-stream to the guest's listener
 *       on `<port>`.
 *     - On failure (no guest listener on that port) Firecracker closes
 *       the connection without replying `OK`.
 *
 *  2. Guest → host (guest connects out to a host-listening port):
 *     - Firecracker forwards the guest's connection to an AF_UNIX socket
 *       at `<uds_path>_<port>` (literally the configured `uds_path` with
 *       `_<port>` appended) — e.g. a guest connecting to host port 52
 *       arrives at `/path/to/v.sock_52`.
 *     - No handshake: the host just needs a `net.Server` listening on
 *       that exact path before the guest connects. If nothing is
 *       listening, Firecracker resets the guest's connection.
 */

import net from 'node:net'

/** Regex for `OK <port>\n` responses from Firecracker's vsock proxy. */
const OK_LINE = /^OK (\d+)\n$/

/**
 * Open a host→guest vsock connection.
 *
 * Connects to the microVM's `uds_path`, performs the `CONNECT <port>`
 * handshake, and resolves with the now-raw `net.Socket` once Firecracker
 * confirms with `OK <port>`.
 *
 * @param {object} opts
 * @param {string} opts.udsPath - the vsock device's `uds_path` (same
 *   value passed to `FirecrackerClient#putVsock`)
 * @param {number} opts.port - guest-side listening port to connect to
 * @param {typeof net.connect} [opts.connect] - injectable for testing
 * @param {number} [opts.timeoutMs=2000] - handshake timeout
 * @returns {Promise<{socket: import('node:net').Socket, assignedPort: number}>}
 */
export function connectToGuest({ udsPath, port, connect = net.connect, timeoutMs = 2000 } = {}) {
  if (!udsPath) throw new Error('connectToGuest: udsPath is required')
  if (!Number.isInteger(port) || port < 0) throw new Error('connectToGuest: port must be a non-negative integer')

  return new Promise((resolve, reject) => {
    const socket = connect(udsPath)
    let buffer = ''
    let settled = false

    const fail = (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.destroy()
      reject(err)
    }

    const timer = setTimeout(() => fail(new Error(`connectToGuest: timed out waiting for OK on port ${port}`)), timeoutMs)

    const onData = (chunk) => {
      buffer += chunk.toString('utf8')
      const nl = buffer.indexOf('\n')
      if (nl === -1) return
      const line = buffer.slice(0, nl + 1)
      const rest = buffer.slice(nl + 1)
      const match = OK_LINE.exec(line)
      if (!match) {
        fail(new Error(`connectToGuest: unexpected response "${line.trim()}"`))
        return
      }
      settled = true
      clearTimeout(timer)
      socket.removeListener('data', onData)
      // Any bytes received after the OK line are already guest payload —
      // push them back so the caller doesn't lose them.
      if (rest.length > 0) socket.unshift(Buffer.from(rest, 'utf8'))
      resolve({ socket, assignedPort: Number(match[1]) })
    }

    socket.on('data', onData)
    socket.on('error', fail)
    socket.on('close', () => fail(new Error('connectToGuest: socket closed before OK')))
    socket.once('connect', () => {
      socket.write(`CONNECT ${port}\n`)
    })
  })
}

/**
 * Listen for guest-initiated vsock connections on a given port.
 *
 * Starts a `net.Server` at `<udsPath>_<port>` — the exact path
 * Firecracker forwards guest connections to for that port — and invokes
 * `onConnection` for each one. No handshake is involved on this side;
 * Firecracker already completed the vsock framing before the guest's
 * bytes arrive here.
 *
 * @param {object} opts
 * @param {string} opts.udsPath - the vsock device's `uds_path`
 * @param {number} opts.port - host-side listening port
 * @param {(socket: import('node:net').Socket) => void} opts.onConnection
 * @param {typeof net.createServer} [opts.createServer] - injectable for testing
 * @returns {Promise<{server: import('node:net').Server, path: string}>}
 */
export function listenForGuest({ udsPath, port, onConnection, createServer = net.createServer } = {}) {
  if (!udsPath) throw new Error('listenForGuest: udsPath is required')
  if (!Number.isInteger(port) || port < 0) throw new Error('listenForGuest: port must be a non-negative integer')
  if (typeof onConnection !== 'function') throw new Error('listenForGuest: onConnection is required')

  const path = `${udsPath}_${port}`
  const server = createServer((socket) => onConnection(socket))

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => {
      server.removeListener('error', reject)
      resolve({ server, path })
    })
  })
}
