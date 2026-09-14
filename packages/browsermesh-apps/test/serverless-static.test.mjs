/**
 * Tests for serverless-static.mjs (Phase 1 of the BrowserMesh Serverless
 * plan -- see that file's own module doc comment, and
 * /Users/johnhenry/.claude/plans/at-some-point-within-joyful-dove.md's
 * "Phase 1" section for the plan text this implements).
 *
 * Exercises `createStaticHandler()` directly against a real, single-peer
 * `CloudStorage` bucket (matching cloud-storage.test.mjs's own fixture
 * pattern) -- no mesh-rpc/router wiring involved yet, per the plan's own
 * Phase 1 verification note ("testable standalone by calling the returned
 * handler directly").
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/serverless-static.test.mjs
 */

import 'fake-indexeddb/auto'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { CloudStorage } from '../src/cloud-storage.mjs'
import { createStaticHandler } from '../src/serverless-static.mjs'
import { PeerRegistry } from '../src/peer-registry.mjs'
import {
  IdentityWallet,
  MeshIdentityManager,
  MeshPeerManager,
  TrustGraph,
  MeshACL,
} from '@johnhenry/browsermesh-core'

const BUCKET = 'my-site'

async function createPeer(label) {
  const identityManager = new MeshIdentityManager({})
  const wallet = new IdentityWallet({ identityManager })
  const { podId } = await wallet.createIdentity(label)
  const registry = new PeerRegistry({
    localPodId: podId,
    peerManager: new MeshPeerManager({}),
    trustGraph: new TrustGraph(),
    acl: new MeshACL({ owner: podId }),
  })
  return {
    podId,
    wallet,
    registry,
    onIncomingData() { return () => {} },
    async sendTo() {},
  }
}

let dbCounter = 0
function freshDbName() {
  dbCounter += 1
  return `serverless-static-test-${dbCounter}`
}

const enc = new TextEncoder()
const dec = new TextDecoder()

describe('createStaticHandler: construction', () => {
  it('throws without a store', () => {
    assert.throws(() => createStaticHandler({}), /opts.store is required/)
  })

  it('throws without checkAccess unless public:true', () => {
    assert.throws(() => createStaticHandler({ store: { getObject: () => {} } }), /opts.checkAccess is required/)
    assert.doesNotThrow(() => createStaticHandler({ store: { getObject: () => {} }, public: true }))
  })
})

describe('createStaticHandler: serving a real CloudStorage bucket', () => {
  let store, handler

  beforeEach(async () => {
    const alice = await createPeer('alice')
    store = new CloudStorage({ bucket: BUCKET, node: alice, dbName: freshDbName(), manifestWaitMs: 200 })
    await store.becomeAdmin()

    await store.put('index.html', '<html>home</html>', { contentType: 'text/html' })
    await store.put('style.css', 'body{color:red}', { contentType: 'text/css' })
    await store.put('about/index.html', '<html>about</html>', { contentType: 'text/html' })
    await store.put('no-contenttype.svg', '<svg/>') // no explicit contentType -- exercises the extension-guess fallback

    handler = createStaticHandler({ store, public: true })
  })

  it("serves '/' as indexFile", async () => {
    const res = await handler({ path: '/' })
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-type'], 'text/html')
    assert.equal(dec.decode(res.body), '<html>home</html>')
  })

  it('serves an exact file match', async () => {
    const res = await handler({ path: '/style.css' })
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-type'], 'text/css')
    assert.equal(dec.decode(res.body), 'body{color:red}')
  })

  it("resolves an implicit directory index ('/about' -> 'about/index.html') when no exact 'about' key exists", async () => {
    const res = await handler({ path: '/about' })
    assert.equal(res.status, 200)
    assert.equal(dec.decode(res.body), '<html>about</html>')
  })

  it('exact file match takes precedence over the directory-index candidate', async () => {
    await store.put('about', 'literally a file named about', { contentType: 'text/plain' })
    const res = await handler({ path: '/about' })
    assert.equal(dec.decode(res.body), 'literally a file named about')
  })

  it('falls back to extension-guessed content-type when put() was given none', async () => {
    const res = await handler({ path: '/no-contenttype.svg' })
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-type'], 'image/svg+xml')
  })

  it('returns null for an unmatched path when spaFallback is false (lets the next chain handler try)', async () => {
    const res = await handler({ path: '/does/not/exist' })
    assert.equal(res, null)
  })

  it('spaFallback:true serves indexFile for an unmatched path', async () => {
    const spaHandler = createStaticHandler({ store, public: true, spaFallback: true })
    const res = await spaHandler({ path: '/some/client/route' })
    assert.equal(res.status, 200)
    assert.equal(dec.decode(res.body), '<html>home</html>')
  })

  it('rejects a path containing a ".." segment with 400, without touching the store', async () => {
    const res = await handler({ path: '/../index.html' })
    assert.equal(res.status, 400)
  })

  it('HEAD uses stat() (no chunk bytes) and returns an empty body with the right content-type', async () => {
    const res = await handler({ path: '/style.css', method: 'HEAD' })
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-type'], 'text/css')
    assert.equal(res.body.length, 0)
  })

  it('returns null for a non-GET/HEAD method (not its concern)', async () => {
    const res = await handler({ path: '/style.css', method: 'POST' })
    assert.equal(res, null)
  })
})

describe('createStaticHandler: gated (non-public) sites', () => {
  it('denies with 403 when checkAccess returns allowed:false, without touching the store', async () => {
    const alice = await createPeer('alice')
    const store = new CloudStorage({ bucket: BUCKET, node: alice, dbName: freshDbName(), manifestWaitMs: 200 })
    await store.becomeAdmin()
    await store.put('index.html', 'secret home', { contentType: 'text/html' })

    const handler = createStaticHandler({
      store,
      checkAccess: (pubKey) => ({ allowed: pubKey === 'trusted-reader', reason: 'not_granted' }),
    })

    const denied = await handler({ path: '/', fromPubKey: 'stranger' })
    assert.equal(denied.status, 403)

    const allowed = await handler({ path: '/', fromPubKey: 'trusted-reader' })
    assert.equal(allowed.status, 200)
    assert.equal(dec.decode(allowed.body), 'secret home')
  })
})
