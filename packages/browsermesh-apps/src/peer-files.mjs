/**
 * peer-files.mjs -- Remote file access over the mesh.
 *
 * Provides browsing, reading, writing, and deleting files on a remote
 * peer's OPFS through `FileHost` (serves local filesystem) and `FileClient`
 * (sends requests and awaits results). Built as a `MeshService`
 * (`mesh-service.mjs`, the same `attach(peerNode, ctx) -> {teardown, api}`
 * convention `mesh-rpc.mjs`/`chunk-replication.mjs`/`grant-log.mjs` etc.
 * already use), NOT on top of `peer-session.mjs`'s `PeerSession`/
 * `SessionManager` -- see "Migration history" below.
 *
 * Kept deliberately, NOT retired despite overlapping with `cloud-storage.mjs`
 * (`CloudStorage`): this is a lighter-weight, unencrypted, non-replicated
 * direct-access option (one `sendTo()` round trip to one specific peer's raw
 * `fs`), not a replacement for CloudStorage's encrypted, manifest-tracked,
 * multi-replica object store. See issue #84/#117-124's triage table for the
 * full per-module decision record.
 *
 * ---------------------------------------------------------------------------
 * Migration history (issue #84, Phase 8 of the app-layer migration plan):
 *
 * This file used to depend on `peer-session.mjs`'s `PeerSession` --
 * `FileHost`/`FileClient` each called `session.registerHandler('files', ...)`
 * in their constructor and `session.send()`/`session.requireCapability()`/
 * `session.remotePodId` from inside their request/response handling. Nothing
 * in this repo ever constructed a live `PeerSession` (`SessionManager` is
 * never instantiated outside its own tests) -- `PeerSession`'s two
 * cross-cutting value-adds (heartbeat, audit logging) are also independently
 * covered by `mesh-keepalive.mjs` (issue #110) and `PeerNode`'s own
 * `#audit()` (issue #85) -- so this migration removes the `PeerSession`
 * dependency entirely rather than bridging it.
 *
 * `FileHost#handleRequest()`/`FileClient`'s `switch(action)`
 * dispatch/`#fs` calls are UNCHANGED from the `PeerSession`-era version --
 * only the transport/correlation plumbing changed:
 *   - `FileHost` no longer owns "who do I reply to" (a `PeerSession` bound
 *     to exactly one remote peer) -- `handleRequest(fromPubKey, payload)` is
 *     now a pure function that COMPUTES and RETURNS a response; the caller
 *     (`createFileShareService()`'s `attach()`, below) sends it via
 *     `ctx.sendTo()`. This is a real, necessary shape change (a `MeshService`
 *     is attached once per NODE and can be asked for files by any connected
 *     peer, not once per peer-pair the way a `PeerSession` was), not a
 *     rewrite of the request-handling logic itself.
 *   - `FileHost`'s capability check (`session.requireCapability(scope)`,
 *     which threw against a static per-session capability list) is now
 *     `ctx.registry.checkAccess(fromPubKey, 'files', action)` -- live,
 *     per-request, per-sender ACL/capability-token checking via
 *     `PeerRegistry` (`peer-registry.mjs`), the same mechanism every other
 *     `MeshService` in this family already uses (see e.g.
 *     `chunk-replication.mjs`, `manifest-sync.mjs`, `mesh-kv.mjs`).
 *     `FILE_CAPABILITIES` moved from `fs:read`/`fs:write`/`fs:delete` to
 *     `files:read`/`files:write`/`files:delete` to align with
 *     `@johnhenry/browsermesh-core`'s `acl.mjs` `DEFAULT_TEMPLATES` (`guest`/
 *     `collaborator` already grant `files:read`/`files:write` -- this was
 *     the family's own established scope vocabulary for this resource, the
 *     module just wasn't using it yet).
 *   - `FileClient` no longer wraps one `PeerSession` bound to one remote
 *     peer -- its public methods (`listFiles`/`readFile`/`writeFile`/
 *     `deleteFile`/`stat`) now take a leading `pubKey` argument, since one
 *     `FileClient` (like `mesh-rpc.mjs`'s `request()`) can request files
 *     from ANY connected peer, not just one fixed session. Internally it
 *     still does exactly what it did before: generate a `requestId`, track
 *     a `{resolve, reject, timer}` in a pending-requests map, and correlate
 *     the eventual response by that id -- this was ALREADY a self-contained
 *     `requestId`-based correlation mechanism (not something `PeerSession`
 *     provided), so no new correlation primitive had to be invented; it's
 *     the exact same shape `mesh-rpc.mjs`'s `request()`/`pendingRequests`
 *     uses, applied here too. The one addition: each pending entry also
 *     records the `pubKey` the request targeted, and `handleResponse()`
 *     ignores a reply from any OTHER peer even if it happens to guess/replay
 *     a `requestId` -- a property the old design got "for free" (a
 *     `PeerSession`'s transport only ever delivered messages from the one
 *     peer it was bound to) that a shared, node-wide `onIncomingData()`
 *     subscription does not.
 *
 * `createFileShareService()` is ONE `MeshService` covering both directions
 * (hosting files to others, and requesting files from others), not two --
 * both share the same `files-request`/`files-response` envelope-type pair
 * and the same `ctx.onIncomingData()` subscription, so splitting them would
 * only duplicate that wiring for no isolation benefit (a node that only
 * wants to be a client passes no `fs`, and `FileHost` is simply never
 * constructed -- see `attach()` below).
 *
 * Run tests:
 *   node --import ./test/_setup-globals.mjs --test test/peer-files.test.mjs
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const FILE_DEFAULTS = Object.freeze({
  maxFileSize: 10 * 1024 * 1024,  // 10MB
  timeout: 30000,                  // 30s
})

export const FILE_ACTIONS = Object.freeze({
  LIST: 'list',
  READ: 'read',
  WRITE: 'write',
  DELETE: 'delete',
  STAT: 'stat',
})

/** `ctx.registry.checkAccess()` resource name used for every file operation (see module doc comment's "Migration history"). */
export const FILE_RESOURCE = 'files'

/**
 * Capability scope strings, `files:read`/`files:write`/`files:delete` --
 * matches `@johnhenry/browsermesh-core`'s `acl.mjs` `DEFAULT_TEMPLATES`
 * vocabulary (`guest`/`collaborator` already grant `files:read`/
 * `files:write`). Kept for documentation/back-compat; the actual check is
 * `ctx.registry.checkAccess(fromPubKey, FILE_RESOURCE, action)` (see
 * `ACTION_CAP_ACTION` below), not a direct comparison against these strings.
 */
export const FILE_CAPABILITIES = Object.freeze({
  READ: 'files:read',
  WRITE: 'files:write',
  DELETE: 'files:delete',
})

/** Default `envelope.type` for a file-operation request, on the shared `ctx.onIncomingData()` bus. */
const DEFAULT_REQUEST_ENVELOPE_TYPE = 'files-request'
/** Default `envelope.type` for a file-operation response. */
const DEFAULT_RESPONSE_ENVELOPE_TYPE = 'files-response'

// ---------------------------------------------------------------------------
// Internal -- map a file action to the capability ACTION (not the full
// scope) `ctx.registry.checkAccess(fromPubKey, FILE_RESOURCE, action)`
// expects as its third argument.
// ---------------------------------------------------------------------------

const ACTION_CAP_ACTION = Object.freeze({
  [FILE_ACTIONS.LIST]: 'read',
  [FILE_ACTIONS.READ]: 'read',
  [FILE_ACTIONS.STAT]: 'read',
  [FILE_ACTIONS.WRITE]: 'write',
  [FILE_ACTIONS.DELETE]: 'delete',
})

// ---------------------------------------------------------------------------
// FileHost
// ---------------------------------------------------------------------------

/**
 * Serves file operations from the local filesystem to remote peers.
 *
 * Framework-agnostic: `handleRequest()` is a pure function that computes and
 * RETURNS a response, it does not send anything itself -- see module doc
 * comment's "Migration history". `createFileShareService()` (below) is what
 * actually wires this to `ctx.onIncomingData()`/`ctx.sendTo()`.
 */
export class FileHost {
  /**
   * @type {object} File system interface (duck-typed)
   *   async list(path) -> { name, type, size }[]
   *   async read(path) -> { data: string|Uint8Array, size: number }
   *   async write(path, data) -> { success, size }
   *   async delete(path) -> { success }
   *   async stat(path) -> { name, type, size, modified }|null
   */
  #fs

  /** @type {number} */
  #maxFileSize

  /** @type {Function} */
  #onLog

  /** @type {(fromPubKey: string, action: string) => ({allowed: boolean, reason?: string})} */
  #checkAccess

  /**
   * @param {object} opts
   * @param {object} opts.fs - File system interface with list/read/write/delete/stat
   * @param {number} [opts.maxFileSize=10485760] - Maximum file size for writes (bytes)
   * @param {Function} [opts.onLog] - Logging callback
   * @param {(fromPubKey: string, action: string) => ({allowed: boolean, reason?: string})} [opts.checkAccess]
   *   Capability check for a given requester + capability action
   *   (`'read'`/`'write'`/`'delete'`, i.e. `ACTION_CAP_ACTION`'s values, NOT
   *   a full `resource:action` scope string). `createFileShareService()`
   *   supplies `(fromPubKey, action) => ctx.registry.checkAccess(fromPubKey, FILE_RESOURCE, action)`.
   *   Defaults to permissive (`{ allowed: true }` for everyone) when
   *   constructed directly without one -- a `FileHost` built by hand (e.g. in
   *   a unit test) has no registry of its own to consult; supplying real
   *   gating is the caller's responsibility, exactly like
   *   `cloud-storage.mjs`/`chunk-replication.mjs` require a real `registry`
   *   at their own composition root.
   */
  constructor({ fs, maxFileSize, onLog, checkAccess }) {
    if (!fs || typeof fs.list !== 'function' || typeof fs.read !== 'function') {
      throw new Error('fs with list() and read() methods is required')
    }

    this.#fs = fs
    this.#maxFileSize = maxFileSize ?? FILE_DEFAULTS.maxFileSize
    this.#onLog = onLog || (() => {})
    this.#checkAccess = typeof checkAccess === 'function' ? checkAccess : () => ({ allowed: true })
  }

  // -- Request handling -------------------------------------------------------

  /**
   * Handle an incoming file operation request from `fromPubKey`.
   *
   * 1. Validates the action and path
   * 2. Checks the required capability via the injected `checkAccess`
   * 3. Dispatches to the appropriate fs method
   * 4. Enforces maxFileSize on writes
   * 5. Returns the response (does NOT send it -- see class doc comment)
   *
   * @param {string} fromPubKey - Requesting peer's public key
   * @param {object} payload - `{ action, path, data?, requestId }`
   * @returns {Promise<{requestId: string|null, action: string|null, success: boolean, result?: *, error?: string}>}
   */
  async handleRequest(fromPubKey, payload) {
    const { action, path, data, requestId } = payload || {}

    const response = {
      requestId: requestId || null,
      action: action || null,
      success: false,
    }

    // 1. Validate action
    if (!action || !Object.values(FILE_ACTIONS).includes(action)) {
      response.error = `Unknown action: ${action}`
      return response
    }

    // 2. Validate path
    if (!path || typeof path !== 'string') {
      response.error = 'path must be a non-empty string'
      return response
    }

    // 3. Check capability
    const capAction = ACTION_CAP_ACTION[action]
    if (capAction) {
      const { allowed, reason } = this.#checkAccess(fromPubKey, capAction) || {}
      if (!allowed) {
        response.error = `Capability "${FILE_RESOURCE}:${capAction}" not granted for ${fromPubKey}${reason ? ` (${reason})` : ''}`
        return response
      }
    }

    try {
      // 4. Dispatch to the appropriate fs method
      switch (action) {
        case FILE_ACTIONS.LIST: {
          this.#onLog(2, `File list request from ${fromPubKey}: ${path}`)
          response.result = await this.#fs.list(path)
          response.success = true
          break
        }

        case FILE_ACTIONS.READ: {
          this.#onLog(2, `File read request from ${fromPubKey}: ${path}`)
          response.result = await this.#fs.read(path)
          response.success = true
          break
        }

        case FILE_ACTIONS.WRITE: {
          // Reject null/undefined data
          if (data == null) {
            response.error = 'Write data is required'
            return response
          }

          // Enforce maxFileSize
          const size = typeof data === 'string'
            ? new TextEncoder().encode(data).byteLength
            : (data.byteLength ?? data.length ?? 0)
          if (size > this.#maxFileSize) {
            response.error = `File size ${size} exceeds maximum ${this.#maxFileSize} bytes`
            return response
          }

          this.#onLog(2, `File write request from ${fromPubKey}: ${path}`)
          const result = await this.#fs.write(path, data)
          response.result = result
          response.success = result.success !== false
          break
        }

        case FILE_ACTIONS.DELETE: {
          this.#onLog(2, `File delete request from ${fromPubKey}: ${path}`)
          const result = await this.#fs.delete(path)
          response.result = result
          response.success = result.success !== false
          break
        }

        case FILE_ACTIONS.STAT: {
          this.#onLog(2, `File stat request from ${fromPubKey}: ${path}`)
          response.result = await this.#fs.stat(path)
          response.success = true
          break
        }
      }
    } catch (err) {
      response.error = err.message
      this.#onLog(0, `File operation error (${action}): ${err.message}`)
    }

    return response
  }

  // -- Serialization ------------------------------------------------------

  /** @returns {object} */
  toJSON() {
    return {
      maxFileSize: this.#maxFileSize,
    }
  }
}

// ---------------------------------------------------------------------------
// FileClient
// ---------------------------------------------------------------------------

/**
 * Client-side interface for accessing remote peers' files.
 *
 * One `FileClient` can request files from ANY connected peer (not bound to
 * a single remote peer the way the `PeerSession`-era version was) -- every
 * public method takes a leading `pubKey` argument. Requests are correlated
 * to their responses by a generated `requestId`, exactly like the
 * `PeerSession`-era version already did (see module doc comment's
 * "Migration history"); the only addition is also recording which `pubKey`
 * a request targeted, so a response claiming a stale/guessed `requestId`
 * from the WRONG peer is ignored rather than resolving/rejecting the wrong
 * promise -- a property a per-peer `PeerSession` transport provided for
 * free that a shared, node-wide subscription does not.
 */
export class FileClient {
  /** @type {(pubKey: string, payload: object) => Promise<void>} */
  #sendRequest

  /** @type {Map<string, { resolve: Function, reject: Function, timer: *, pubKey: string }>} */
  #pendingRequests = new Map()

  /** @type {number} default timeout in ms */
  #timeout

  /** @type {Function} */
  #onLog

  /**
   * @param {object} opts
   * @param {(pubKey: string, payload: object) => Promise<void>} opts.sendRequest
   *   Sends a `files-request`-shaped payload to `pubKey`. `createFileShareService()`
   *   supplies `(pubKey, payload) => ctx.sendTo(pubKey, 'files-request', payload)`.
   * @param {number} [opts.timeout=30000] - Default timeout for requests in ms
   * @param {Function} [opts.onLog] - Logging callback
   */
  constructor({ sendRequest, timeout, onLog }) {
    if (typeof sendRequest !== 'function') {
      throw new Error('sendRequest function is required')
    }

    this.#sendRequest = sendRequest
    this.#timeout = timeout ?? FILE_DEFAULTS.timeout
    this.#onLog = onLog || (() => {})
  }

  // -- File operations ------------------------------------------------------

  /**
   * List files at a path on a remote peer.
   *
   * @param {string} pubKey - Remote peer to query
   * @param {string} path - Directory path to list
   * @returns {Promise<{ name: string, type: string, size: number }[]>}
   */
  async listFiles(pubKey, path) {
    const response = await this.#request(pubKey, FILE_ACTIONS.LIST, path)
    return response.result
  }

  /**
   * Read a file from a remote peer.
   *
   * @param {string} pubKey - Remote peer to query
   * @param {string} path - File path to read
   * @returns {Promise<{ data: string|Uint8Array, size: number }>}
   */
  async readFile(pubKey, path) {
    const response = await this.#request(pubKey, FILE_ACTIONS.READ, path)
    return response.result
  }

  /**
   * Write data to a file on a remote peer.
   *
   * @param {string} pubKey - Remote peer to write to
   * @param {string} path - File path to write
   * @param {string|Uint8Array} data - File content to write
   * @returns {Promise<{ success: boolean, size: number }>}
   */
  async writeFile(pubKey, path, data) {
    const response = await this.#request(pubKey, FILE_ACTIONS.WRITE, path, data)
    return response.result
  }

  /**
   * Delete a file on a remote peer.
   *
   * @param {string} pubKey - Remote peer to delete on
   * @param {string} path - File path to delete
   * @returns {Promise<{ success: boolean }>}
   */
  async deleteFile(pubKey, path) {
    const response = await this.#request(pubKey, FILE_ACTIONS.DELETE, path)
    return response.result
  }

  /**
   * Get file metadata from a remote peer.
   *
   * @param {string} pubKey - Remote peer to query
   * @param {string} path - File path to stat
   * @returns {Promise<{ name: string, type: string, size: number, modified: number }|null>}
   */
  async stat(pubKey, path) {
    const response = await this.#request(pubKey, FILE_ACTIONS.STAT, path)
    return response.result
  }

  // -- Internal request handling --------------------------------------------

  /**
   * Send a file operation request to `pubKey` and wait for the matching response.
   *
   * @param {string} pubKey - Target peer
   * @param {string} action - File action (list, read, write, delete, stat)
   * @param {string} path - File path
   * @param {*} [data] - Optional data payload (for write)
   * @returns {Promise<{ requestId, action, success, result?, error? }>}
   */
  async #request(pubKey, action, path, data) {
    if (!pubKey || typeof pubKey !== 'string') {
      throw new Error('pubKey must be a non-empty string')
    }
    if (!path || typeof path !== 'string') {
      throw new Error('path must be a non-empty string')
    }

    const requestId = crypto.randomUUID()
    const timeoutMs = this.#timeout

    return new Promise((resolve, reject) => {
      // Set up timeout
      const timer = setTimeout(() => {
        const pending = this.#pendingRequests.get(requestId)
        if (pending) {
          this.#pendingRequests.delete(requestId)
          const err = new Error(`File request timed out after ${timeoutMs}ms`)
          err.code = 'FILE_TIMEOUT'
          reject(err)
        }
      }, timeoutMs)

      // Register pending request
      this.#pendingRequests.set(requestId, { resolve, reject, timer, pubKey })

      // Build and send request payload
      const payload = { action, path, requestId }
      if (data !== undefined) {
        payload.data = data
      }

      Promise.resolve(this.#sendRequest(pubKey, payload))
        .then(() => {
          this.#onLog(2, `Sent file ${action} request to ${pubKey}: ${path}`)
        })
        .catch((err) => {
          clearTimeout(timer)
          this.#pendingRequests.delete(requestId)
          reject(err)
        })
    })
  }

  // -- Response handling ------------------------------------------------------

  /**
   * Handle an incoming file response. Matches by requestId (AND the peer it
   * was sent to -- see class doc comment) and resolves or rejects the
   * pending promise.
   *
   * @param {string} fromPubKey - Peer the response actually arrived from
   * @param {object} payload - `{ requestId, action, success, result?, error? }`
   */
  handleResponse(fromPubKey, payload) {
    const { requestId } = payload || {}
    if (!requestId) return

    const pending = this.#pendingRequests.get(requestId)
    if (!pending) return

    // A response claiming this requestId but arriving from a different peer
    // than the one it was sent to is never valid -- ignore it rather than
    // resolving/rejecting the wrong caller's promise (see class doc comment).
    if (pending.pubKey !== fromPubKey) return

    // Clean up
    clearTimeout(pending.timer)
    this.#pendingRequests.delete(requestId)

    // Check for errors
    if (payload.error) {
      const err = new Error(payload.error)
      err.code = 'FILE_REMOTE_ERROR'
      pending.reject(err)
      return
    }

    // Resolve with the full response
    pending.resolve(payload)
  }

  // -- Lifecycle ------------------------------------------------------------

  /**
   * Close the file client. Rejects all pending requests.
   */
  close() {
    for (const [, pending] of this.#pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(new Error('FileClient closed'))
    }
    this.#pendingRequests.clear()
  }

  // -- Serialization --------------------------------------------------------

  /** @returns {object} */
  toJSON() {
    return {
      pendingRequests: this.#pendingRequests.size,
      timeout: this.#timeout,
    }
  }
}

// ---------------------------------------------------------------------------
// createFileShareService -- the MeshService descriptor
// ---------------------------------------------------------------------------

/**
 * Build a `MeshService` descriptor (`mesh-service.mjs`) wiring `FileHost`/
 * `FileClient` onto `ctx.sendTo()`/`ctx.onIncomingData()`. One service
 * covers both directions -- hosting files to other peers (if `fs` is
 * supplied) and requesting files from other peers (always available via the
 * returned `api`) -- see module doc comment for why this isn't split into
 * two descriptors.
 *
 * @param {object} [opts]
 * @param {object} [opts.fs] - File system interface for `FileHost` (list/read/
 *   write/delete/stat, list+read required, others optional per action). If
 *   omitted, this node does not host files -- inbound `files-request`
 *   envelopes still get a clean `{success: false, error: 'this peer is not
 *   hosting files'}` response rather than being silently dropped (matching
 *   `mesh-rpc.mjs`'s "no handler registered" convention) or crashing the
 *   shared dispatch loop.
 * @param {number} [opts.maxFileSize] - See `FileHost`.
 * @param {number} [opts.timeout] - See `FileClient`.
 * @param {Function} [opts.onLog]
 * @param {string} [opts.resource='files'] - `ctx.registry.checkAccess()` resource
 *   name (see `FILE_RESOURCE`). Override to scope file access under a
 *   different capability namespace than the family default.
 * @param {string} [opts.requestEnvelopeType='files-request']
 * @param {string} [opts.responseEnvelopeType='files-response']
 * @returns {import('./mesh-service.mjs').MeshService}
 */
export function createFileShareService({
  fs,
  maxFileSize,
  timeout,
  onLog,
  resource = FILE_RESOURCE,
  requestEnvelopeType = DEFAULT_REQUEST_ENVELOPE_TYPE,
  responseEnvelopeType = DEFAULT_RESPONSE_ENVELOPE_TYPE,
} = {}) {
  const log = onLog || (() => {})

  return {
    name: 'file-share',

    attach(peerNode, ctx) {
      const fileHost = fs
        ? new FileHost({
          fs,
          maxFileSize,
          onLog,
          checkAccess: (fromPubKey, capAction) => ctx.registry.checkAccess(fromPubKey, resource, capAction),
        })
        : null

      const fileClient = new FileClient({
        timeout,
        onLog,
        sendRequest: (pubKey, payload) => ctx.sendTo(pubKey, requestEnvelopeType, payload),
      })

      const unsubscribeRequests = ctx.onIncomingData(requestEnvelopeType, async (fromPubKey, msg) => {
        let response
        try {
          response = fileHost
            ? await fileHost.handleRequest(fromPubKey, msg)
            : {
              requestId: msg?.requestId ?? null,
              action: msg?.action ?? null,
              success: false,
              error: 'this peer is not hosting files',
            }
        } catch (err) {
          // FileHost#handleRequest() already catches every fs-operation
          // error itself -- reaching here would mean something unexpected
          // (e.g. checkAccess() throwing). Never let it become an unhandled
          // rejection or crash the shared onIncomingData() dispatch loop.
          log('file-share:request-handling-failed', { from: fromPubKey, requestId: msg?.requestId, error: err?.message || String(err) })
          response = { requestId: msg?.requestId ?? null, action: msg?.action ?? null, success: false, error: err?.message || String(err) }
        }

        ctx.emit('file-share:request-served', { from: fromPubKey, action: response.action, success: response.success })

        try {
          await ctx.sendTo(fromPubKey, responseEnvelopeType, response)
        } catch (err) {
          log('file-share:response-send-failed', { to: fromPubKey, requestId: response.requestId, error: err?.message || String(err) })
        }
      })

      const unsubscribeResponses = ctx.onIncomingData(responseEnvelopeType, (fromPubKey, msg) => {
        fileClient.handleResponse(fromPubKey, msg)
      })

      const api = {
        host: fileHost,
        client: fileClient,
        listFiles: (pubKey, path) => fileClient.listFiles(pubKey, path),
        readFile: (pubKey, path) => fileClient.readFile(pubKey, path),
        writeFile: (pubKey, path, data) => fileClient.writeFile(pubKey, path, data),
        deleteFile: (pubKey, path) => fileClient.deleteFile(pubKey, path),
        stat: (pubKey, path) => fileClient.stat(pubKey, path),
      }

      return {
        api,
        teardown() {
          unsubscribeRequests()
          unsubscribeResponses()
          fileClient.close()
        },
      }
    },
  }
}

export { DEFAULT_REQUEST_ENVELOPE_TYPE, DEFAULT_RESPONSE_ENVELOPE_TYPE }
