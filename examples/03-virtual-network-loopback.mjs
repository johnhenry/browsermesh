/**
 * BSD-socket-style virtual networking, entirely in-process.
 *
 * browsermesh-netway gives browser code the same listen/connect/accept
 * shape as a real socket API, without needing an actual network stack.
 * `VirtualNetwork` ships with a `LoopbackBackend` pre-registered for the
 * `mem://` and `loop://` schemes — this example opens a listener, connects
 * a client, accepts the resulting server-side socket, and moves real bytes
 * both directions, exactly like a TCP echo server would, but with zero
 * sockets, ports, or firewalls involved.
 */

import assert from 'node:assert/strict'
import { VirtualNetwork } from '@johnhenry/browsermesh-netway'

const net = new VirtualNetwork()

const listener = await net.listen('mem://localhost:8080')
console.log('listening on mem://localhost:8080')

const client = await net.connect('mem://localhost:8080')
const server = await listener.accept()
console.log('client connected, server accepted')

// Client -> server
await client.write(new TextEncoder().encode('ping'))
const fromClient = await server.read()
assert.equal(new TextDecoder().decode(fromClient), 'ping')
console.log('server received:', new TextDecoder().decode(fromClient))

// Server -> client (bidirectional — this is a real duplex stream, not a
// one-shot request/response)
await server.write(new TextEncoder().encode('pong'))
const fromServer = await client.read()
assert.equal(new TextDecoder().decode(fromServer), 'pong')
console.log('client received:', new TextDecoder().decode(fromServer))

// Byte-accurate: binary payloads round-trip exactly, not just text.
const binary = new Uint8Array([0, 1, 2, 127, 128, 255])
await client.write(binary)
const echoed = await server.read()
assert.deepEqual(echoed, binary)
console.log('binary payload round-trips byte-for-byte ✓')

await client.close()
await server.close()
listener.close()
await net.close()

console.log('ok: listen/connect/accept/read/write all moved real bytes over the loopback backend')
