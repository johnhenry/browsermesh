/**
 * Learning that a peer runs the message channel, and which protocols it
 * serves, from what it advertises, without trying it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { network } from './helpers/rpc-network.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { createMeshChannelService, CHANNEL_VERSION, CHANNEL_MIN_VERSION } from '../src/mesh-channel.mjs'
import {
  CHANNEL_CAPABILITY,
  channelAdvertisement,
  readChannelAdvertisement,
  peerSupportsFromAdvertisements,
  advertisedProtocolSupport,
} from '../src/channel-advertisement.mjs'

function spy(node) {
  const sent = []
  const original = node.sendTo.bind(node)
  node.sendTo = (id, message) => { sent.push({ to: id, message }); return original(id, message) }
  return sent
}

test('an advertisement names the channel, its version range and the protocols served', () => {
  const ad = channelAdvertisement({ protocols: { objects: [1, 2], counter: [1] } })
  assert.ok(ad.capabilities.includes(CHANNEL_CAPABILITY))
  assert.ok(ad.capabilities.includes('protocol:objects'))
  assert.deepEqual(ad.metadata.meshChannel, { version: CHANNEL_VERSION, minVersion: CHANNEL_MIN_VERSION, protocols: { counter: [1], objects: [1, 2] } })
  assert.deepEqual(channelAdvertisement().metadata.meshChannel.protocols, {})
  assert.throws(() => channelAdvertisement({ protocols: { 'Bad Name': [1] } }), /protocol name/)
  assert.throws(() => channelAdvertisement({ protocols: { ok: [0] } }), /versions/)
})

test('reading a peer record: nothing advertised is unknown, not unsupported', () => {
  assert.equal(readChannelAdvertisement(null), null)
  assert.equal(readChannelAdvertisement({}), null)
  assert.equal(readChannelAdvertisement({ capabilities: ['pod-host'] }), null, 'a peer that advertises other things is still unknown for the channel')
  const ad = channelAdvertisement({ protocols: { counter: [1] } })
  assert.deepEqual(readChannelAdvertisement({ capabilities: ad.capabilities, metadata: ad.metadata }).protocols, { counter: [1] })
  assert.equal(readChannelAdvertisement({ capabilities: [CHANNEL_CAPABILITY] }).version, CHANNEL_VERSION)
})

test('a hostile or malformed advertisement reads as unknown or as nothing served', () => {
  assert.equal(readChannelAdvertisement({ capabilities: 'mesh-channel' }), null)
  const odd = readChannelAdvertisement({
    capabilities: [CHANNEL_CAPABILITY],
    metadata: { meshChannel: { protocols: { objects: 'x', ok: [1, 'a', -3, 2.5, 2], '': [1], [`${'n'.repeat(200)}`]: [1] } } },
  })
  assert.deepEqual(odd.protocols, { ok: [1, 2] })
})

test('protocol support: false only when the peer advertised the channel without that protocol or version', () => {
  const ad = readChannelAdvertisement(channelAdvertisement({ protocols: { counter: [1, 2] } }))
  assert.equal(advertisedProtocolSupport(ad, 'counter', [2, 3]), true)
  assert.equal(advertisedProtocolSupport(ad, 'counter', [3]), false)
  assert.equal(advertisedProtocolSupport(ad, 'objects', [1]), false)
  assert.equal(advertisedProtocolSupport(null, 'objects', [1]), undefined)
})

test('peerSupports: nothing known is tried, a channel that cannot overlap our versions is not, an advertised one is', () => {
  const records = new Map()
  const supports = peerSupportsFromAdvertisements(peer => records.get(peer) ?? null)
  assert.equal(supports('nobody'), undefined)
  records.set('other', { capabilities: ['pod-host'] })
  assert.equal(supports('other'), undefined)
  records.set('good', channelAdvertisement())
  assert.equal(supports('good'), true)
  records.set('future', { capabilities: [CHANNEL_CAPABILITY], metadata: { meshChannel: { version: CHANNEL_VERSION + 5, minVersion: CHANNEL_VERSION + 5, protocols: {} } } })
  assert.equal(supports('future'), false)
  const throwing = peerSupportsFromAdvertisements(() => { throw new Error('lookup failed') })
  assert.equal(throwing('x'), undefined, 'a failing lookup is "unknown", never a refusal')
})

test('open() with that hook sends nothing to a peer known not to overlap, and still tries one that says nothing', async () => {
  const [alice, bob] = await network()
  const sent = spy(alice)
  const records = new Map()
  const a = attachService(alice, undefined, createMeshChannelService({
    peerSupports: peerSupportsFromAdvertisements(peer => records.get(peer) ?? null),
    handshakeTimeoutMs: 25,
  }))
  try {
    await assert.rejects(a.api.open(bob.podId), { reason: 'unsupported' })
    assert.equal(sent.length, 1, 'unknown: tried')
    records.set(bob.podId, { capabilities: [CHANNEL_CAPABILITY], metadata: { meshChannel: { version: CHANNEL_VERSION + 5, minVersion: CHANNEL_VERSION + 5, protocols: {} } } })
    await assert.rejects(a.api.open(bob.podId), { reason: 'unsupported' })
    assert.equal(sent.length, 1, 'known not to overlap: nothing sent')
  } finally { a.teardown() }
})

test('a peer that advertises the channel is opened', async () => {
  const [alice, bob] = await network()
  const records = new Map([[bob.podId, channelAdvertisement({ protocols: {} })]])
  const a = attachService(alice, undefined, createMeshChannelService({ peerSupports: peerSupportsFromAdvertisements(peer => records.get(peer) ?? null) }))
  const b = attachService(bob, undefined, createMeshChannelService())
  try {
    assert.ok(await a.api.open(bob.podId))
  } finally { a.teardown(); b.teardown() }
})
