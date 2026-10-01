import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, unlinkSync } from 'node:fs'
import { connectToGuest, listenForGuest } from '../src/vsock-bridge.mjs'

const cleanup = []
after(() => {
  for (const p of cleanup) {
    if (existsSync(p)) unlinkSync(p)
  }
})

/**
 * Minimal fake implementation of Firecracker's host-connects-out vsock
 * handshake: accepts a connection, expects "CONNECT <port>\n", and
 * either replies "OK <port>\n" (then echoes further bytes) or, for
 * `badPort`, closes the connection with no reply at all (mirroring a
 * guest with nothing listening on that port).
 */
function startFakeVsockUds(socketPath, { badPort } = {}) {
  cleanup.push(socketPath)
  const server = net.createServer((socket) => {
    let buf = ''
    const onHandshake = (chunk) => {
      buf += chunk.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      const line = buf.slice(0, nl)
      const match = /^CONNECT (\d+)$/.exec(line)
      if (!match) { socket.destroy(); return }
      const port = Number(match[1])
      // Stop treating further bytes as handshake input *before* replying —
      // otherwise the handshake listener stays registered alongside the
      // echo listener below and double-processes/double-echoes whatever
      // the client sends next.
      socket.removeListener('data', onHandshake)
      if (port === badPort) {
        socket.destroy()
        return
      }
      socket.write(`OK ${port}\n`)
      socket.on('data', (d) => socket.write(d)) // echo guest payload
    }
    socket.on('data', onHandshake)
  })
  return new Promise((resolve) => server.listen(socketPath, () => resolve(server)))
}

describe('connectToGuest', () => {
  it('performs the CONNECT/OK handshake and resolves a raw socket', async () => {
    const socketPath = join(tmpdir(), `vsock-ok-${process.pid}.sock`)
    const server = await startFakeVsockUds(socketPath)
    let socket
    try {
      const result = await connectToGuest({ udsPath: socketPath, port: 52 })
      socket = result.socket
      assert.equal(result.assignedPort, 52)
      const echoed = await new Promise((resolve) => {
        socket.once('data', (d) => resolve(d.toString('utf8')))
        socket.write('hello guest')
      })
      assert.equal(echoed, 'hello guest')
    } finally {
      socket?.destroy()
      server.close()
    }
  })

  it('rejects when the connection closes without an OK (no guest listener)', async () => {
    const socketPath = join(tmpdir(), `vsock-bad-${process.pid}.sock`)
    const server = await startFakeVsockUds(socketPath, { badPort: 99 })
    try {
      await assert.rejects(() => connectToGuest({ udsPath: socketPath, port: 99, timeoutMs: 500 }))
    } finally {
      server.close()
    }
  })

  it('rejects on an unexpected response line', async () => {
    const socketPath = join(tmpdir(), `vsock-garbled-${process.pid}.sock`)
    cleanup.push(socketPath)
    const server = net.createServer((socket) => {
      socket.on('data', () => socket.write('NOPE not a real response\n'))
    })
    await new Promise((resolve) => server.listen(socketPath, resolve))
    try {
      await assert.rejects(() => connectToGuest({ udsPath: socketPath, port: 1, timeoutMs: 500 }), /unexpected response/)
    } finally {
      server.close()
    }
  })

  it('validates its arguments', () => {
    assert.throws(() => connectToGuest({ port: 1 }), /udsPath is required/)
    assert.throws(() => connectToGuest({ udsPath: '/tmp/x.sock', port: -1 }), /port must be/)
  })
})

describe('listenForGuest', () => {
  it('listens at <udsPath>_<port> and invokes onConnection for guest-initiated connects', async () => {
    const udsPath = join(tmpdir(), `vsock-host-${process.pid}.sock`)
    const expectedPath = `${udsPath}_52`
    cleanup.push(expectedPath)

    let received = null
    const { server, path } = await listenForGuest({
      udsPath, port: 52,
      onConnection: (socket) => {
        socket.once('data', (d) => { received = d.toString('utf8') })
      },
    })
    assert.equal(path, expectedPath)

    const client = net.connect(expectedPath)
    await new Promise((resolve) => client.once('connect', resolve))
    client.write('guest says hi')
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(received, 'guest says hi')

    client.destroy()
    await new Promise((resolve) => server.close(resolve))
  })

  it('validates its arguments', async () => {
    assert.throws(() => listenForGuest({ port: 1, onConnection: () => {} }), /udsPath is required/)
    assert.throws(() => listenForGuest({ udsPath: '/tmp/x.sock', onConnection: () => {} }), /port must be/)
    assert.throws(() => listenForGuest({ udsPath: '/tmp/x.sock', port: 1 }), /onConnection is required/)
  })
})
