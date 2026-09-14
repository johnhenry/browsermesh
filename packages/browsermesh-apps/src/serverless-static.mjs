/**
 * serverless-static.mjs -- Phase 1 of the BrowserMesh Serverless plan
 * (`/Users/johnhenry/.claude/plans/at-some-point-within-joyful-dove.md`):
 * static-site serving backed by `CloudStorage` (`cloud-storage.mjs`).
 *
 * Adapts `actually-serverless`'s `createFileSystemHandler.mjs` (File System
 * Access API, one browser tab's local folder) to a mesh-native equivalent:
 * a `CloudStorage` bucket's flat, replicated key-value store stands in for
 * the local folder, so the same site can be served by any peer holding (or
 * able to read-repair) the bucket's chunks, not just the machine the files
 * happen to live on.
 *
 * `CloudStorage.list()` is a flat KV store with prefix-match only -- no
 * directory-tree semantics to lean on (confirmed by reading
 * `cloud-storage-backend.mjs`'s `#opList()`) -- so index.html resolution,
 * implicit-directory-index lookup, and SPA fallback are all built fresh
 * here, not inherited from anywhere.
 *
 * ---------------------------------------------------------------------------
 * PUBLIC vs GATED SITES (see the plan doc's "Research findings", point 4).
 *
 * No wildcard-peer grant primitive exists anywhere in this repo's ACL stack
 * (confirmed by reading `peer-registry.mjs`/`grant-log.mjs` directly:
 * `checkAccess()`/`grant()` are both keyed by an exact pubKey string). A
 * "public" static site therefore does NOT rely on `CloudStorage`'s own
 * per-bucket ACL at all for reads -- `CloudStorage.getObject()` has no
 * reader-identity concept in the first place; it just reads whatever this
 * peer's own local store already holds. The gate implemented here is a
 * SEPARATE, router-facing decision: when `opts.public` is false, the caller
 * (Phase 2's `serverless-router.mjs`, which has `fromPubKey` and a real
 * `registry.checkAccess`) must supply `opts.checkAccess`, and every request
 * is checked against it before this handler ever touches the store. When
 * `opts.public` is true, that check is skipped entirely -- literally
 * "this peer already has read access to its own bucket, and will re-serve
 * those bytes to anyone who reaches it over mesh-rpc." State this plainly:
 * it is a router-layer policy, not a `GrantLog` feature.
 *
 * @module serverless-static
 */

import { CloudStorageNotFoundError } from './cloud-storage.mjs'

/** @type {Record<string, string>} common static-site extensions -> MIME type, used only as a fallback when `put()` was never given an explicit `contentType`. */
const EXT_CONTENT_TYPES = {
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  map: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  txt: 'text/plain',
  xml: 'application/xml',
  wasm: 'application/wasm',
  pdf: 'application/pdf',
}

/**
 * @param {string} key
 * @returns {string}
 */
function guessContentType(key) {
  const dot = key.lastIndexOf('.')
  const ext = dot === -1 ? '' : key.slice(dot + 1).toLowerCase()
  return EXT_CONTENT_TYPES[ext] || 'application/octet-stream'
}

/**
 * True if any path segment is literally `..` -- rejected outright rather
 * than collapsed/resolved. `CloudStorage` keys are opaque flat strings, not
 * real filesystem paths, so there is no actual traversal vulnerability to
 * escape a root directory with -- this is defense-in-depth/predictability
 * (reject the request rather than silently mapping `/../secret` to some
 * unintended key), not a fix for an exploitable bug.
 *
 * @param {string} path
 * @returns {boolean}
 */
function hasTraversal(path) {
  return path.split('/').some((segment) => segment === '..')
}

/**
 * Build the ordered list of `CloudStorage` keys to try for an incoming
 * request path, in the same precedence `actually-serverless`'s own static
 * handler uses (exact file, then implicit directory index):
 *   '/'           -> [indexFile]
 *   '/foo/'       -> ['foo/' + indexFile]
 *   '/foo'        -> ['foo', 'foo/' + indexFile]   (file first, then directory index)
 *   '/foo/bar.js' -> ['foo/bar.js']
 *
 * @param {string} path
 * @param {string} indexFile
 * @returns {string[]}
 */
function buildCandidateKeys(path, indexFile) {
  const normalized = path.startsWith('/') ? path.slice(1) : path
  if (normalized === '') return [indexFile]
  if (normalized.endsWith('/')) return [normalized + indexFile]
  if (/\.[^/]+$/.test(normalized)) return [normalized] // has a file extension -- don't also try it as a directory
  return [normalized, `${normalized}/${indexFile}`]
}

/**
 * @typedef {object} StaticRequest
 * @property {string} path - request path, e.g. `/about/index.html` or `/`.
 * @property {string} [method='GET']
 * @property {string} [fromPubKey] - the requesting peer's identity, required unless `opts.public`.
 */

/**
 * @typedef {object} StaticResponse
 * @property {number} status
 * @property {Record<string,string>} headers
 * @property {Uint8Array|string} body
 */

/**
 * @param {object} opts
 * @param {import('./cloud-storage.mjs').CloudStorage} opts.store - a `CloudStorage`-like object exposing `getObject(key)` and, optionally, `stat(key)`.
 * @param {string} [opts.indexFile='index.html']
 * @param {boolean} [opts.spaFallback=false] - serve `indexFile` for any path that doesn't resolve to a stored key, for client-side-routed SPAs.
 * @param {boolean} [opts.public=false] - skip the read-access gate entirely (see module doc comment above). Mutually exclusive in effect with `opts.checkAccess`.
 * @param {(pubKey: string, resource: string, action: string) => {allowed: boolean, reason?: string}} [opts.checkAccess] - required unless `opts.public` is true.
 * @param {string} [opts.resource] - defaults to `store.resource` (a real `CloudStorage`'s own `s3:<bucket>` resource tag).
 * @returns {(req: StaticRequest) => Promise<StaticResponse|null>} null means "not mine, try the next handler in this site's chain."
 */
export function createStaticHandler({ store, indexFile = 'index.html', spaFallback = false, public: isPublic = false, checkAccess, resource } = {}) {
  if (!store || typeof store.getObject !== 'function') {
    throw new Error('createStaticHandler: opts.store is required and must be a CloudStorage-like object (getObject())')
  }
  if (!isPublic && typeof checkAccess !== 'function') {
    throw new Error('createStaticHandler: opts.checkAccess is required unless opts.public is true')
  }
  const gateResource = resource || store.resource

  return async function handleStatic({ path, method = 'GET', fromPubKey } = {}) {
    if (method !== 'GET' && method !== 'HEAD') return null // not a static-file request -- let the next handler in the chain try

    if (!isPublic) {
      const decision = checkAccess(fromPubKey, gateResource, 'read')
      if (!decision?.allowed) {
        return { status: 403, headers: { 'content-type': 'text/plain' }, body: 'Forbidden' }
      }
    }

    const safePath = path || '/'
    if (hasTraversal(safePath)) {
      return { status: 400, headers: { 'content-type': 'text/plain' }, body: 'Bad Request' }
    }

    const candidates = buildCandidateKeys(safePath, indexFile)
    for (const key of candidates) {
      const hit = await fetchKey(store, key, method)
      if (hit) return hit
    }

    if (spaFallback) {
      const hit = await fetchKey(store, indexFile, method)
      if (hit) return hit
    }

    return null // not found -- let the next handler in the chain (functions/proxy) try, or the router 404s
  }
}

/**
 * @param {import('./cloud-storage.mjs').CloudStorage} store
 * @param {string} key
 * @param {string} method
 * @returns {Promise<StaticResponse|null>}
 */
async function fetchKey(store, key, method) {
  try {
    if (method === 'HEAD' && typeof store.stat === 'function') {
      // Avoid pulling chunk bytes across the mesh (Phase G's lazy pull) just
      // to answer a HEAD -- stat() only needs the manifest entry to have
      // synced, not the content itself.
      const meta = await store.stat(key)
      return { status: 200, headers: { 'content-type': meta.contentType || guessContentType(key) }, body: new Uint8Array() }
    }
    const { data, contentType } = await store.getObject(key)
    return {
      status: 200,
      headers: { 'content-type': contentType || guessContentType(key) },
      body: method === 'HEAD' ? new Uint8Array() : data,
    }
  } catch (err) {
    if (err instanceof CloudStorageNotFoundError) return null
    throw err
  }
}
