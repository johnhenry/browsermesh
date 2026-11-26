/**
 * createMeshNode({ identity: { podId } }): adopt an identity that already
 * exists in the supplied identityManager instead of minting a new one, so a
 * page can keep its key across a reload (docs/design/realms.md 5.10).
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/mesh-bootstrap-identity.test.mjs
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const { createMeshNode } = await import('../src/mesh-bootstrap.mjs')
const { MeshIdentityManager } = await import('@johnhenry/browsermesh-core')

function stubSignaling() {
  return { send() {}, onMessage() {} }
}

function boot(extra = {}) {
  return createMeshNode({ signalingTransport: stubSignaling(), skipBoot: true, ...extra })
}

describe('createMeshNode: identity option', () => {
  it('default path still creates one fresh identity per call', async () => {
    const manager = new MeshIdentityManager()
    await boot({ identityManager: manager, label: 'first' })
    await boot({ identityManager: manager, label: 'second' })
    assert.equal(manager.list().length, 2)
  })

  it('adopts an identity that already exists and creates nothing', async () => {
    const manager = new MeshIdentityManager()
    const { podId } = await manager.create('kept')
    const node = await boot({ identityManager: manager, identity: { podId } })
    assert.equal(node.podId, podId)
    assert.equal(manager.list().length, 1, 'no new identity was created')
  })

  it('adopts the same identity again on a second call (a reload)', async () => {
    const manager = new MeshIdentityManager()
    const { podId } = await manager.create('kept')
    const one = await boot({ identityManager: manager, identity: { podId } })
    const two = await boot({ identityManager: manager, identity: { podId } })
    assert.equal(one.podId, podId)
    assert.equal(two.podId, podId)
    assert.equal(manager.list().length, 1)
  })

  it('adopts a non-default identity and makes it the node\'s identity', async () => {
    const manager = new MeshIdentityManager()
    const first = await manager.create('first')
    const second = await manager.create('second')
    assert.equal(manager.getDefault().podId, first.podId)
    const node = await boot({ identityManager: manager, identity: { podId: second.podId } })
    assert.equal(node.podId, second.podId)
    assert.equal(manager.list().length, 2)
  })

  it('signs with the adopted key', async () => {
    const manager = new MeshIdentityManager()
    const { podId } = await manager.create('kept')
    const node = await boot({ identityManager: manager, identity: { podId } })
    const bytes = new TextEncoder().encode('hello')
    const sig = await node.wallet.sign(podId, bytes)
    assert.ok(sig)
  })

  it('throws a clear error when the pod id is not in the manager, and creates nothing', async () => {
    const manager = new MeshIdentityManager()
    await manager.create('other')
    await assert.rejects(
      boot({ identityManager: manager, identity: { podId: 'no-such-pod' } }),
      /createMeshNode: options\.identity\.podId "no-such-pod" is not in the supplied identityManager/,
    )
    assert.equal(manager.list().length, 1)
  })

  it('throws when identity is given without an identityManager to find it in', async () => {
    await assert.rejects(
      boot({ identity: { podId: 'abc' } }),
      /createMeshNode: options\.identity needs options\.identityManager/,
    )
  })

  it('throws a TypeError for a malformed identity option', async () => {
    const manager = new MeshIdentityManager()
    for (const bad of [{}, { podId: '' }, { podId: 5 }, 'abc', null]) {
      await assert.rejects(
        boot({ identityManager: manager, identity: bad }),
        TypeError,
        `identity: ${JSON.stringify(bad)}`,
      )
    }
  })

  it('identity: undefined behaves as if the option were absent', async () => {
    const manager = new MeshIdentityManager()
    const node = await boot({ identityManager: manager, identity: undefined })
    assert.equal(manager.list().length, 1)
    assert.ok(node.podId)
  })
})
