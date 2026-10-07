import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { loadOrCreateIdentity } from '../src/identity.mjs'
import { runCli, withTempIdentityDir } from './helpers.mjs'

describe('identity persistence', () => {
  it('creates and persists an identity on first load', async () => {
    const { identityPath, cleanup } = await withTempIdentityDir()
    try {
      const identity = await loadOrCreateIdentity({ identityPath })
      assert.equal(identity.created, true)
      assert.equal(typeof identity.podId, 'string')
      assert.ok(identity.podId.length > 0)

      const stored = JSON.parse(await readFile(identityPath, 'utf8'))
      assert.equal(stored.podId, identity.podId)
      assert.ok(stored.privateKeyJwk)

      const mode = (await stat(identityPath)).mode & 0o777
      assert.equal(mode, 0o600)
    } finally {
      await cleanup()
    }
  })

  it('round-trips the same podId on a second load', async () => {
    const { identityPath, cleanup } = await withTempIdentityDir()
    try {
      const first = await loadOrCreateIdentity({ identityPath })
      const second = await loadOrCreateIdentity({ identityPath })
      assert.equal(second.created, false)
      assert.equal(second.podId, first.podId)
      assert.equal(second.label, first.label)
    } finally {
      await cleanup()
    }
  })

  it('a corrupt identity file is reported, not silently overwritten', async () => {
    const { identityPath, cleanup } = await withTempIdentityDir()
    try {
      const { writeFile, mkdir } = await import('node:fs/promises')
      const { dirname } = await import('node:path')
      await mkdir(dirname(identityPath), { recursive: true })
      await writeFile(identityPath, '{ not json')
      await assert.rejects(loadOrCreateIdentity({ identityPath }), /not valid JSON/)
    } finally {
      await cleanup()
    }
  })

  it('meshctl identity (CLI) round-trips podId across two invocations', async () => {
    const { identityPath, cleanup } = await withTempIdentityDir()
    try {
      const first = await runCli(['identity', '--identity', identityPath])
      const firstDoc = JSON.parse(first.stdout)
      assert.equal(firstDoc.result.created, true)

      const second = await runCli(['identity', '--identity', identityPath])
      const secondDoc = JSON.parse(second.stdout)
      assert.equal(secondDoc.result.created, false)
      assert.equal(secondDoc.result.podId, firstDoc.result.podId)
    } finally {
      await cleanup()
    }
  })
})
