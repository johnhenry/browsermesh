// The guest's exec responder (guest/vsock-exec-responder.mjs) run as the real
// process it is inside the guest, spoken to by the host's real exec client
// (src/vsock-bridge.mjs execOverVsock) through a stand-in for Firecracker's
// vsock proxy on a unix socket. Until now the two ends of this protocol had
// only ever been tested against fakes of each other.
//
// What is still a stand-in: the proxy (a real Firecracker does the CONNECT/OK
// handshake and carries the bytes over AF_VSOCK; the guest's `socat` bridge
// from vsock to the responder's unix socket is not part of this test).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { execOverVsock } from '../src/vsock-bridge.mjs'

const RESPONDER = fileURLToPath(new URL('../guest/vsock-exec-responder.mjs', import.meta.url))
const PORT = 52

describe('guest exec responder, over the host exec client', () => {
  let dir
  let responder
  let proxy
  let udsPath
  const refused = []

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vsock-responder-'))
    const guestSocket = path.join(dir, 'vsock-exec.sock')
    udsPath = path.join(dir, 'v.sock')
    // A stale socket file from a previous boot must not stop the responder from starting.
    await writeFile(guestSocket, '')

    responder = spawn(process.execPath, [RESPONDER], {
      env: { ...process.env, VSOCK_EXEC_SOCKET: guestSocket },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    await new Promise((resolve, reject) => {
      responder.once('error', reject)
      responder.once('exit', (code) => reject(new Error(`responder exited early (${code})`)))
      responder.stdout.on('data', (chunk) => { if (String(chunk).includes('listening')) resolve() })
    })

    // Firecracker's host-side vsock proxy: `CONNECT <port>` -> `OK <n>`, then raw bytes to the guest listener.
    proxy = net.createServer((client) => {
      let buffer = ''
      const onData = (chunk) => {
        buffer += chunk.toString('utf8')
        const nl = buffer.indexOf('\n')
        if (nl === -1) return
        client.off('data', onData)
        if (buffer.slice(0, nl) !== `CONNECT ${PORT}`) { refused.push(buffer.slice(0, nl)); client.destroy(); return }
        const guest = net.connect(guestSocket)
        guest.once('connect', () => {
          client.write('OK 1073741824\n')
          const rest = buffer.slice(nl + 1)
          if (rest) guest.write(rest)
          client.pipe(guest)
          guest.pipe(client)
        })
        guest.on('error', () => client.destroy())
        client.on('error', () => guest.destroy())
      }
      client.on('data', onData)
    })
    await new Promise((resolve) => proxy.listen(udsPath, resolve))
  })

  after(async () => {
    proxy?.close()
    responder?.removeAllListeners('exit')
    responder?.kill()
    await rm(dir, { recursive: true, force: true })
  })

  const run = (command) => execOverVsock({ udsPath, port: PORT, command })

  it('runs a command and returns its output and exit code', async () => {
    const result = await run(['sh', '-c', 'echo out; echo err >&2; exit 3'])
    assert.deepEqual(result, { stdout: 'out\n', stderr: 'err\n', code: 3 })
  })

  it('succeeds with code 0', async () => {
    assert.deepEqual(await run(['echo', 'hello from the guest']), { stdout: 'hello from the guest\n', stderr: '', code: 0 })
  })

  it('never runs the argument through a shell', async () => {
    const result = await run(['echo', '$(echo injected)', ';', 'echo', 'second'])
    assert.equal(result.stdout, '$(echo injected) ; echo second\n')
  })

  it('reports a command that does not exist as a non-zero numeric code, not a string', async () => {
    const result = await run(['/definitely/not/a/binary'])
    assert.equal(typeof result.code, 'number')
    assert.notEqual(result.code, 0)
  })

  it('answers each connection on its own: two commands in flight do not mix their output', async () => {
    const [a, b] = await Promise.all([run(['sh', '-c', 'sleep 0.1; echo a']), run(['echo', 'b'])])
    assert.equal(a.stdout, 'a\n')
    assert.equal(b.stdout, 'b\n')
  })

  it('closes the connection without a result for a request it cannot parse', async () => {
    for (const line of ['NOPE', 'EXEC !!!not-base64-json!!!', `EXEC ${Buffer.from('[]').toString('base64')}`, `EXEC ${Buffer.from('"ls"').toString('base64')}`]) {
      const reply = await new Promise((resolve, reject) => {
        const socket = net.connect(udsPath)
        let buf = ''
        socket.on('error', reject)
        socket.on('data', (c) => { buf += c.toString('utf8') })
        socket.on('close', () => resolve(buf))
        socket.once('connect', () => socket.write(`CONNECT ${PORT}\n${line}\n`))
      })
      assert.doesNotMatch(reply, /RESULT/, `answered ${JSON.stringify(line)}`)
    }
  })
})
