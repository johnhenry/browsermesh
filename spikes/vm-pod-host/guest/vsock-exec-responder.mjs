/**
 * guest/vsock-exec-responder.mjs — tiny exec responder for the vsock
 * bridge described in guest/init.
 *
 * Listens on the local UNIX socket /run/vsock-exec.sock (which `socat`
 * bridges to Firecracker's AF_VSOCK port 52 — see guest/init for why
 * socat, not a native Node vsock binding). Speaks the same line protocol
 * `src/host-pod.mjs#exec()` writes against:
 *
 *   host  -> guest: "EXEC <base64 JSON argv>\n"
 *   guest -> host:  "RESULT <base64 JSON {stdout,stderr,code}>\n"
 *
 * Deliberately tiny: no job queue, no concurrency control, one command
 * per connection. Good enough for a spike's `execOnPod`; a real
 * deployment would want timeouts, output streaming, and a resource cap
 * per command (the `KERNEL_CAP.STDIO` / `KERNEL_CAP.FS` gates from issue
 * #185 §6 belong here, not just at the orchestrator).
 *
 * Run as a process and spoken to by the host's exec client in
 * `test/guest-responder.test.mjs` (through a stand-in for Firecracker's vsock
 * proxy). Not yet run inside a real guest: the `socat` bridge from AF_VSOCK to
 * this socket in `guest/init` has never run.
 */

import net from 'node:net'
import { execFile } from 'node:child_process'
import { unlinkSync, existsSync } from 'node:fs'

// `VSOCK_EXEC_SOCKET` exists so the responder can be run, and tested, outside a
// guest; inside one it is unset and `guest/init` bridges this exact path.
const SOCKET_PATH = process.env.VSOCK_EXEC_SOCKET || '/run/vsock-exec.sock'

if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH)

const server = net.createServer((socket) => {
  let buf = ''
  socket.on('data', (chunk) => {
    buf += chunk.toString('utf8')
    const nl = buf.indexOf('\n')
    if (nl === -1) return
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)

    const match = /^EXEC (.+)$/.exec(line)
    if (!match) {
      socket.end()
      return
    }

    let argv
    try {
      argv = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'))
    } catch {
      socket.end()
      return
    }
    if (!Array.isArray(argv) || argv.length === 0) {
      socket.end()
      return
    }

    // CodeQL js/command-line-injection fires here, and it is right that the
    // argv comes from the socket: executing host-supplied commands IS this
    // program's purpose (it is the guest end of `execOnPod`). The security
    // boundary is the Firecracker microVM around this process, not this
    // file: the socket is reachable only from the host agent over vsock,
    // argv is passed to execFile (no shell), and the guest has only the
    // rootfs, /data and the rate-limited NIC the host gave it. See issue
    // #185 §5 and §7. Alert dismissed as "won't fix / by design" on PR #186.
    const [cmd, ...args] = argv
    execFile(cmd, args, { timeout: 30_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const result = {
        stdout: stdout ?? '',
        stderr: stderr ?? (err ? String(err.message) : ''),
        // Always a number: Node reports a missing binary as the string 'ENOENT'.
        code: err ? (typeof err.code === 'number' ? err.code : err.code === 'ENOENT' ? 127 : 1) : 0,
      }
      const payload = Buffer.from(JSON.stringify(result)).toString('base64')
      socket.end(`RESULT ${payload}\n`)
    })
  })
})

server.listen(SOCKET_PATH, () => {
  console.log(`[vsock-exec-responder] listening on ${SOCKET_PATH}`)
})
