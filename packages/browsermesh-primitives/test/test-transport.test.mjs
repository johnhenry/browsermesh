import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  DeterministicRNG,
  LocalChannel,
  createLocalChannelPair,
  TestMesh,
  TESTMESH_LIMITS,
} from '../src/test-transport.mjs'

// ---------------------------------------------------------------------------
// DeterministicRNG
// ---------------------------------------------------------------------------

describe('DeterministicRNG', () => {
  it('produces floats in [0, 1)', () => {
    const rng = new DeterministicRNG(42)
    for (let i = 0; i < 1000; i++) {
      const v = rng.next()
      assert.ok(v >= 0 && v < 1, `Out of range: ${v}`)
    }
  })

  it('produces deterministic sequences from the same seed', () => {
    const a = new DeterministicRNG(12345)
    const b = new DeterministicRNG(12345)
    for (let i = 0; i < 100; i++) {
      assert.equal(a.next(), b.next(), `Mismatch at step ${i}`)
    }
  })

  it('produces different sequences from different seeds', () => {
    const a = new DeterministicRNG(1)
    const b = new DeterministicRNG(2)
    let same = 0
    for (let i = 0; i < 100; i++) {
      if (a.next() === b.next()) same++
    }
    assert.ok(same < 5, 'Too many collisions between different seeds')
  })

  it('reset changes the sequence', () => {
    const rng = new DeterministicRNG(42)
    const first = rng.next()
    rng.reset(42)
    assert.equal(rng.next(), first)
  })
})

// ---------------------------------------------------------------------------
// LocalChannel basics
// ---------------------------------------------------------------------------

describe('LocalChannel', () => {
  it('has a unique id', () => {
    const ch = new LocalChannel()
    assert.ok(ch.id)
    assert.equal(typeof ch.id, 'string')
  })

  it('starts in open state', () => {
    const ch = new LocalChannel()
    assert.equal(ch.state, 'open')
    assert.equal(ch.type, 'message-port')
  })

  it('close transitions to closed state', () => {
    const ch = new LocalChannel()
    ch.close()
    assert.equal(ch.state, 'closed')
  })

  it('close fires onclose callback', () => {
    const ch = new LocalChannel()
    let called = false
    ch.onclose = () => { called = true }
    ch.close()
    assert.ok(called)
  })

  it('close is idempotent', () => {
    const ch = new LocalChannel()
    let count = 0
    ch.onclose = () => { count++ }
    ch.close()
    ch.close()
    assert.equal(count, 1)
  })

  it('send on closed channel fires onerror', () => {
    const ch = new LocalChannel()
    ch.close()
    let error = null
    ch.onerror = (e) => { error = e }
    ch.send({ test: true })
    assert.ok(error)
    assert.equal(error.code, 'CHANNEL_CLOSED')
    assert.equal(error.fatal, false)
  })

  it('send without peer fires onerror', () => {
    const ch = new LocalChannel()
    let error = null
    ch.onerror = (e) => { error = e }
    ch.send('hello')
    assert.ok(error)
    assert.equal(error.code, 'PEER_CLOSED')
  })
})

// ---------------------------------------------------------------------------
// createLocalChannelPair
// ---------------------------------------------------------------------------

describe('createLocalChannelPair', () => {
  it('returns two open channels', () => {
    const [a, b] = createLocalChannelPair()
    assert.equal(a.state, 'open')
    assert.equal(b.state, 'open')
  })

  it('delivers messages between paired channels (zero latency)', () => {
    const [a, b] = createLocalChannelPair()
    const received = []
    b.onmessage = (e) => received.push(e.data)

    a.send({ type: 'PING' })
    a.send({ type: 'PONG' })

    assert.deepEqual(received, [{ type: 'PING' }, { type: 'PONG' }])
    a.close()
    b.close()
  })

  it('isolates messages via structuredClone', () => {
    const [a, b] = createLocalChannelPair()
    let receivedData = null
    b.onmessage = (e) => { receivedData = e.data }

    const sent = { value: 1 }
    a.send(sent)
    sent.value = 999

    assert.equal(receivedData.value, 1)
    a.close()
    b.close()
  })

  it('delivers in both directions', () => {
    const [a, b] = createLocalChannelPair()
    const fromA = []
    const fromB = []
    b.onmessage = (e) => fromA.push(e.data)
    a.onmessage = (e) => fromB.push(e.data)

    a.send('hello')
    b.send('world')

    assert.deepEqual(fromA, ['hello'])
    assert.deepEqual(fromB, ['world'])
    a.close()
    b.close()
  })

  it('sets source on delivered events', () => {
    const [a, b] = createLocalChannelPair()
    let event = null
    b.onmessage = (e) => { event = e }
    a.send('test')
    assert.equal(event.source, a)
    a.close()
    b.close()
  })

  it('send to closed peer fires onerror', () => {
    const [a, b] = createLocalChannelPair()
    b.close()
    let error = null
    a.onerror = (e) => { error = e }
    a.send('hello')
    assert.ok(error)
    assert.equal(error.code, 'PEER_CLOSED')
    a.close()
  })
})

// ---------------------------------------------------------------------------
// Latency simulation
// ---------------------------------------------------------------------------

describe('latency simulation', () => {
  it('delivers messages after configured delay', async () => {
    const [a, b] = createLocalChannelPair({ latencyMs: 50 })

    const deliveryPromise = new Promise((resolve) => {
      b.onmessage = resolve
    })

    const start = performance.now()
    a.send({ type: 'TIMED' })

    const event = await deliveryPromise
    const elapsed = performance.now() - start

    assert.ok(elapsed >= 40, `Expected >=40ms, got ${elapsed}ms`)
    assert.deepEqual(event.data, { type: 'TIMED' })

    a.close()
    b.close()
  })

  it('does not deliver to peer that closed during delay', async () => {
    const [a, b] = createLocalChannelPair({ latencyMs: 50 })
    let received = false
    b.onmessage = () => { received = true }

    a.send('test')
    b.close() // Close before delivery

    await new Promise((r) => setTimeout(r, 80))
    assert.equal(received, false)
    a.close()
  })
})

// ---------------------------------------------------------------------------
// Deterministic drop rate
// ---------------------------------------------------------------------------

describe('deterministic drops', () => {
  it('drops messages reproducibly with seed', () => {
    const seed = 12345

    // Run 1
    const [a1, b1] = createLocalChannelPair({ dropRate: 0.3, seed })
    const received1 = []
    b1.onmessage = (e) => received1.push(e.data)
    for (let i = 0; i < 100; i++) a1.send(i)

    // Run 2 (same seed)
    const [a2, b2] = createLocalChannelPair({ dropRate: 0.3, seed })
    const received2 = []
    b2.onmessage = (e) => received2.push(e.data)
    for (let i = 0; i < 100; i++) a2.send(i)

    assert.deepEqual(received1, received2)
    assert.ok(received1.length < 100, 'Expected some drops')
    assert.ok(received1.length > 50, 'Expected most to arrive')

    a1.close(); b1.close()
    a2.close(); b2.close()
  })

  it('dropRate 0 drops nothing', () => {
    const [a, b] = createLocalChannelPair({ dropRate: 0, seed: 42 })
    const received = []
    b.onmessage = (e) => received.push(e.data)
    for (let i = 0; i < 50; i++) a.send(i)
    assert.equal(received.length, 50)
    a.close(); b.close()
  })
})

// ---------------------------------------------------------------------------
// Queue overflow
// ---------------------------------------------------------------------------

describe('queue overflow', () => {
  it('fires onerror when peer queue is full', () => {
    const [a, b] = createLocalChannelPair({ maxQueueSize: 3 })
    // Don't set onmessage — messages accumulate in queue
    a.send(1)
    a.send(2)
    a.send(3)

    let error = null
    a.onerror = (e) => { error = e }
    a.send(4) // Should overflow
    assert.ok(error)
    assert.equal(error.code, 'QUEUE_FULL')
    a.close(); b.close()
  })
})

// ---------------------------------------------------------------------------
// AsyncIterator
// ---------------------------------------------------------------------------

describe('AsyncIterator', () => {
  it('yields messages and terminates on close', async () => {
    const [a, b] = createLocalChannelPair()

    a.send({ seq: 1 })
    a.send({ seq: 2 })
    a.send({ seq: 3 })

    // Close sender after a tick so iterator can drain
    setTimeout(() => b.close(), 10)

    const received = []
    for await (const event of b) {
      received.push(event.data.seq)
    }

    assert.deepEqual(received, [1, 2, 3])
    a.close()
  })

  it('works with zero messages', async () => {
    const [a, b] = createLocalChannelPair()
    setTimeout(() => b.close(), 5)

    const received = []
    for await (const event of b) {
      received.push(event.data)
    }
    assert.deepEqual(received, [])
    a.close()
  })

  it('receives messages sent after iterator starts', async () => {
    const [a, b] = createLocalChannelPair()

    // Send after a delay
    setTimeout(() => {
      a.send('delayed')
      b.close()
    }, 10)

    const received = []
    for await (const event of b) {
      received.push(event.data)
    }
    assert.deepEqual(received, ['delayed'])
    a.close()
  })
})

// ---------------------------------------------------------------------------
// TestMesh
// ---------------------------------------------------------------------------

describe('TestMesh', () => {
  it('creates n pods with correct ids', async () => {
    const mesh = await TestMesh.create(4)
    assert.equal(mesh.pods.length, 4)
    assert.equal(mesh.pods[0].id, 'test-pod-0')
    assert.equal(mesh.pods[3].id, 'test-pod-3')
    await mesh.shutdown()
  })

  it('creates n*(n-1)/2 channel pairs', async () => {
    const mesh = await TestMesh.create(4)
    // 4 pods -> 6 pairs -> 12 directional channels
    for (let i = 0; i < 4; i++) {
      assert.equal(mesh.pods[i].channels.size, 3) // connected to 3 others
    }
    await mesh.shutdown()
  })

  it('full connectivity — every pod can reach every other pod', async () => {
    const mesh = await TestMesh.create(3)
    const results = new Map()

    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        if (i === j) continue
        const key = `${i}->${j}`
        mesh.getChannel(j, i).onmessage = (e) => {
          // Note: getChannel(j,i) is pod j's view of channel from i
          // Actually: getChannel(fromIndex, toIndex) = channel FROM fromIndex TO toIndex
          // So messages sent on getChannel(i, j) arrive on j's side
        }
      }
    }

    // Verify each pair has a working channel
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        if (i === j) continue
        const received = []
        const ch = mesh.getChannel(j, i) // channel at pod j, connected to pod i
        // Actually let's just use the pod's channels map directly
        const chFromI = mesh.pods[i].channels.get(j)
        const chAtJ = mesh.pods[j].channels.get(i)
        chAtJ.onmessage = (e) => received.push(e.data)
        chFromI.send(`hello from ${i} to ${j}`)
        assert.equal(received.length, 1, `No message from ${i} to ${j}`)
        assert.equal(received[0], `hello from ${i} to ${j}`)
      }
    }

    await mesh.shutdown()
  })

  it('getChannel throws for invalid indices', async () => {
    const mesh = await TestMesh.create(3)
    assert.throws(() => mesh.getChannel(0, 0)) // same pod
    assert.throws(() => mesh.getChannel(0, 5)) // out of range
    await mesh.shutdown()
  })

  it('rejects pod count < 2', async () => {
    await assert.rejects(() => TestMesh.create(1), /Pod count must be between/)
  })

  it('rejects pod count > maxPods', async () => {
    await assert.rejects(() => TestMesh.create(65), /Pod count must be between/)
  })

  it('assigns pod kinds cyclically', async () => {
    const mesh = await TestMesh.create(4, { kinds: ['worker', 'iframe'] })
    assert.equal(mesh.pods[0].kind, 'worker')
    assert.equal(mesh.pods[1].kind, 'iframe')
    assert.equal(mesh.pods[2].kind, 'worker')
    assert.equal(mesh.pods[3].kind, 'iframe')
    await mesh.shutdown()
  })
})

// ---------------------------------------------------------------------------
// TestMesh fault injection
// ---------------------------------------------------------------------------

describe('TestMesh fault injection', () => {
  it('partition closes channels between groups', async () => {
    const mesh = await TestMesh.create(4)

    mesh.injectFault({
      type: 'partition',
      groupA: ['test-pod-0', 'test-pod-1'],
      groupB: ['test-pod-2', 'test-pod-3'],
    })

    // Cross-partition channels should be closed
    assert.equal(mesh.getChannel(0, 2).state, 'closed')
    assert.equal(mesh.getChannel(2, 0).state, 'closed')
    assert.equal(mesh.getChannel(1, 3).state, 'closed')

    // Intra-partition channels should still be open
    assert.equal(mesh.getChannel(0, 1).state, 'open')
    assert.equal(mesh.getChannel(2, 3).state, 'open')

    await mesh.shutdown()
  })

  it('partition with duration auto-heals', async () => {
    const mesh = await TestMesh.create(4)

    mesh.injectFault({
      type: 'partition',
      groupA: ['test-pod-0'],
      groupB: ['test-pod-2'],
      duration: 50,
    })

    assert.equal(mesh.getChannel(0, 2).state, 'closed')

    await new Promise((r) => setTimeout(r, 80))

    // After healing, new channels should be available
    const healed = mesh.getChannel(0, 2)
    assert.equal(healed.state, 'open')

    await mesh.shutdown()
  })

  it('latency injection modifies channel options', async () => {
    const mesh = await TestMesh.create(3)

    mesh.injectFault({
      type: 'latency',
      targets: ['*'],
      delayMs: 100,
      jitterMs: 10,
    })

    // Verify options were modified
    const ch = mesh.getChannel(0, 1)
    assert.equal(ch._options.latencyMs, 100)
    assert.equal(ch._options.jitterMs, 10)

    await mesh.shutdown()
  })

  it('message-drop injection modifies channel options', async () => {
    const mesh = await TestMesh.create(3)

    mesh.injectFault({
      type: 'message-drop',
      targets: ['test-pod-1'],
      dropRate: 0.5,
    })

    // Pod 1's channels should have dropRate
    const ch = mesh.pods[1].channels.get(0)
    assert.equal(ch._options.dropRate, 0.5)

    // Pod 0's channels should be unaffected
    const ch0 = mesh.pods[0].channels.get(1)
    assert.equal(ch0._options.dropRate, 0)

    await mesh.shutdown()
  })

  it('unsupported fault type throws', async () => {
    const mesh = await TestMesh.create(3)
    assert.throws(() => mesh.injectFault({ type: 'unknown' }), /Unsupported fault type/)
    await mesh.shutdown()
  })
})

// ---------------------------------------------------------------------------
// TestMesh shutdown
// ---------------------------------------------------------------------------

describe('TestMesh shutdown', () => {
  it('closes all channels', async () => {
    const mesh = await TestMesh.create(3)
    const channels = [
      mesh.getChannel(0, 1),
      mesh.getChannel(1, 0),
      mesh.getChannel(0, 2),
    ]

    await mesh.shutdown()

    for (const ch of channels) {
      assert.equal(ch.state, 'closed')
    }
  })

  it('clears pod channel maps', async () => {
    const mesh = await TestMesh.create(3)
    await mesh.shutdown()
    for (const pod of mesh.pods) {
      assert.equal(pod.channels.size, 0)
    }
  })
})

// ---------------------------------------------------------------------------
// Deterministic seed replay
// ---------------------------------------------------------------------------

describe('deterministic seed replay', () => {
  it('same seed + same messages = identical delivery pattern', () => {
    const seed = 9999
    const opts = { dropRate: 0.2, reorderRate: 0, seed }

    // Run 1
    const [a1, b1] = createLocalChannelPair(opts)
    const r1 = []
    b1.onmessage = (e) => r1.push(e.data)
    for (let i = 0; i < 50; i++) a1.send(i)

    // Run 2
    const [a2, b2] = createLocalChannelPair(opts)
    const r2 = []
    b2.onmessage = (e) => r2.push(e.data)
    for (let i = 0; i < 50; i++) a2.send(i)

    assert.deepEqual(r1, r2)

    a1.close(); b1.close()
    a2.close(); b2.close()
  })
})
