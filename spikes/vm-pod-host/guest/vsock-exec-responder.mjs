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
 * NOT executed by this spike — see the top-level README.md. Written and
 * reviewed as source; runs only inside a real guest rootfs on a real
 * KVM host.
 */

import net from 'node:net'
import { execFile } from 'node:child_process'
import { unlinkSync, existsSync } from 'node:fs'

const SOCKET_PATH = '/run/vsock-exec.sock'

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

    const [cmd, ...args] = argv
    execFile(cmd, args, { timeout: 30_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const result = {
        stdout: stdout ?? '',
        stderr: stderr ?? (err ? String(err.message) : ''),
        code: err ? (err.code ?? 1) : 0,
      }
      const payload = Buffer.from(JSON.stringify(result)).toString('base64')
      socket.end(`RESULT ${payload}\n`)
    })
  })
})

server.listen(SOCKET_PATH, () => {
  console.log(`[vsock-exec-responder] listening on ${SOCKET_PATH}`)
})
