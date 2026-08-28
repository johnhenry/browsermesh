/**
// STATUS: EXPERIMENTAL — complete implementation, not yet integrated into main application
 * clawser-peer-files.js -- Remote file access over peer sessions.
 *
 * Provides browsing, reading, writing, and deleting files on a remote
 * peer's OPFS through FileHost (serves local filesystem) and FileClient
 * (sends requests and awaits results). Built on top of PeerSession's
 * service handler system using the 'files' service type.
 *
 * Dependencies are injected (PeerSession, fs interface).
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-peer-files.test.mjs
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

export const FILE_CAPABILITIES = Object.freeze({
  READ: 'fs:read',
  WRITE: 'fs:write',
  DELETE: 'fs:delete',
})

// ---------------------------------------------------------------------------
// Internal — map actions to required capabilities
// ---------------------------------------------------------------------------

const ACTION_CAPABILITY = Object.freeze({
  [FILE_ACTIONS.LIST]: FILE_CAPABILITIES.READ,
  [FILE_ACTIONS.READ]: FILE_CAPABILITIES.READ,
  [FILE_ACTIONS.STAT]: FILE_CAPABILITIES.READ,
  [FILE_ACTIONS.WRITE]: FILE_CAPABILITIES.WRITE,
  [FILE_ACTIONS.DELETE]: FILE_CAPABILITIES.DELETE,
})

// ---------------------------------------------------------------------------
// FileHost
// ---------------------------------------------------------------------------

/**
 * Serves file operations from the local filesystem to remote peers.
 *
 * Registers a handler on the PeerSession for the 'files' service type.
 * Incoming requests are validated against capability requirements and
 * file size limits before execution. The remote peer must hold the
 * appropriate capability on the session (fs:read, fs:write, fs:delete).
 */
export class FileHost {
  /** @type {object} PeerSession */
  #session

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

  /**
   * @param {object} opts
   * @param {object} opts.session - PeerSession instance
   * @param {object} opts.fs - File system interface with list/read/write/delete/stat
   * @param {number} [opts.maxFileSize=10485760] - Maximum file size for writes (bytes)
   * @param {Function} [opts.onLog] - Logging callback
   */
  constructor({ session, fs, maxFileSize, onLog }) {
    if (!session) {
      throw new Error('session is required')
    }
    if (!fs || typeof fs.list !== 'function' || typeof fs.read !== 'function') {
      throw new Error('fs with list() and read() methods is required')
    }

    this.#session = session
    this.#fs = fs
    this.#maxFileSize = maxFileSize ?? FILE_DEFAULTS.maxFileSize
    this.#onLog = onLog || (() => {})

    // Register handler on session for 'files' service type
    this.#session.registerHandler('files', (envelope) => this.#handleRequest(envelope))
  }

  // -- Request handling (private) -------------------------------------------

  /**
   * Handle an incoming file operation request.
   *
   * 1. Validates the action and path
   * 2. Checks the required capability on the session
   * 3. Dispatches to the appropriate fs method
   * 4. Enforces maxFileSize on writes
   * 5. Sends the response back via session
   *
   * @param {object} envelope - Session envelope with payload
   */
  async #handleRequest(envelope) {
    const payload = envelope.payload || envelope
    const { action, path, data, requestId } = payload

    // Build base response
    const response = {
      requestId: requestId || null,
      action: action || null,
      success: false,
    }

    try {
      // 1. Validate action
      if (!action || !Object.values(FILE_ACTIONS).includes(action)) {
        response.error = `Unknown action: ${action}`
        this.#session.send('files', response)
        return
      }

      // 2. Validate path
      if (!path || typeof path !== 'string') {
        response.error = 'path must be a non-empty string'
        this.#session.send('files', response)
        return
      }

      // 3. Check capability
      const requiredCap = ACTION_CAPABILITY[action]
      if (requiredCap) {
        this.#session.requireCapability(requiredCap)
      }

      // 4. Dispatch to the appropriate fs method
      let result
      switch (action) {
        case FILE_ACTIONS.LIST: {
          this.#onLog(2, `File list request from ${this.#session.remotePodId}: ${path}`)
          result = await this.#fs.list(path)
          response.success = true
          response.result = result
          break
        }

        case FILE_ACTIONS.READ: {
          this.#onLog(2, `File read request from ${this.#session.remotePodId}: ${path}`)
          result = await this.#fs.read(path)
          response.success = true
          response.result = result
          break
        }

        case FILE_ACTIONS.WRITE: {
          // Reject null/undefined data
          if (data == null) {
            response.error = 'Write data is required'
            this.#session.send('files', response)
            return
          }

          // Enforce maxFileSize
          const size = typeof data === 'string'
            ? new TextEncoder().encode(data).byteLength
            : (data.byteLength ?? data.length ?? 0)
          if (size > this.#maxFileSize) {
            response.error = `File size ${size} exceeds maximum ${this.#maxFileSize} bytes`
            this.#session.send('files', response)
            return
          }

          this.#onLog(2, `File write request from ${this.#session.remotePodId}: ${path}`)
          result = await this.#fs.write(path, data)
          response.success = result.success !== false
          response.result = result
          break
        }

        case FILE_ACTIONS.DELETE: {
          this.#onLog(2, `File delete request from ${this.#session.remotePodId}: ${path}`)
          result = await this.#fs.delete(path)
          response.success = result.success !== false
          response.result = result
          break
        }

        case FILE_ACTIONS.STAT: {
          this.#onLog(2, `File stat request from ${this.#session.remotePodId}: ${path}`)
          result = await this.#fs.stat(path)
          response.success = true
          response.result = result
          break
        }
      }
    } catch (err) {
      response.error = err.message
      this.#onLog(0, `File operation error (${action}): ${err.message}`)
    }

    // Send response back
    this.#session.send('files', response)
  }

  // -- Lifecycle ------------------------------------------------------------

  /**
   * Close the file host. Removes the handler from the session.
   */
  close() {
    this.#session.removeHandler('files')
  }

  // -- Serialization --------------------------------------------------------

  /**
   * Serialize to a JSON-safe object.
   *
   * @returns {object}
   */
  toJSON() {
    return {
      sessionId: this.#session.sessionId,
      localPodId: this.#session.localPodId,
      remotePodId: this.#session.remotePodId,
      maxFileSize: this.#maxFileSize,
    }
  }
}

// ---------------------------------------------------------------------------
// FileClient
// ---------------------------------------------------------------------------

/**
 * Client-side interface for accessing a remote peer's files.
 *
 * Sends file operation requests via the PeerSession and waits for
 * responses matched by requestId. Supports configurable timeout per
 * request and provides promise-based methods for each file operation.
 */
export class FileClient {
  /** @type {object} PeerSession */
  #session

  /** @type {Map<string, { resolve: Function, reject: Function, timer: * }>} */
  #pendingRequests = new Map()

  /** @type {number} default timeout in ms */
  #timeout

  /** @type {Function} */
  #onLog

  /**
   * @param {object} opts
   * @param {object} opts.session - PeerSession instance
   * @param {number} [opts.timeout=30000] - Default timeout for requests in ms
   * @param {Function} [opts.onLog] - Logging callback
   */
  constructor({ session, timeout, onLog }) {
    if (!session) {
      throw new Error('session is required')
    }

    this.#session = session
    this.#timeout = timeout ?? FILE_DEFAULTS.timeout
    this.#onLog = onLog || (() => {})

    // Register handler on session for 'files' response messages
    this.#session.registerHandler('files', (envelope) => this.#handleResponse(envelope))
  }

  // -- File operations ------------------------------------------------------

  /**
   * List files at a path on the remote peer.
   *
   * @param {string} path - Directory path to list
   * @returns {Promise<{ name: string, type: string, size: number }[]>}
   */
  async listFiles(path) {
    const response = await this.#request(FILE_ACTIONS.LIST, path)
    return response.result
  }

  /**
   * Read a file from the remote peer.
   *
   * @param {string} path - File path to read
   * @returns {Promise<{ data: string|Uint8Array, size: number }>}
   */
  async readFile(path) {
    const response = await this.#request(FILE_ACTIONS.READ, path)
    return response.result
  }

  /**
   * Write data to a file on the remote peer.
   *
   * @param {string} path - File path to write
   * @param {string|Uint8Array} data - File content to write
   * @returns {Promise<{ success: boolean, size: number }>}
   */
  async writeFile(path, data) {
    const response = await this.#request(FILE_ACTIONS.WRITE, path, data)
    return response.result
  }

  /**
   * Delete a file on the remote peer.
   *
   * @param {string} path - File path to delete
   * @returns {Promise<{ success: boolean }>}
   */
  async deleteFile(path) {
    const response = await this.#request(FILE_ACTIONS.DELETE, path)
    return response.result
  }

  /**
   * Get file metadata from the remote peer.
   *
   * @param {string} path - File path to stat
   * @returns {Promise<{ name: string, type: string, size: number, modified: number }|null>}
   */
  async stat(path) {
    const response = await this.#request(FILE_ACTIONS.STAT, path)
    return response.result
  }

  // -- Internal request handling --------------------------------------------

  /**
   * Send a file operation request and wait for the matching response.
   *
   * Creates a unique requestId, sends the request via the session,
   * and returns a promise that resolves when the response arrives
   * or rejects on timeout.
   *
   * @param {string} action - File action (list, read, write, delete, stat)
   * @param {string} path - File path
   * @param {*} [data] - Optional data payload (for write)
   * @returns {Promise<{ requestId, action, success, result?, error? }>}
   */
  async #request(action, path, data) {
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
      this.#pendingRequests.set(requestId, { resolve, reject, timer })

      // Build and send request payload
      const payload = { action, path, requestId }
      if (data !== undefined) {
        payload.data = data
      }

      try {
        this.#session.send('files', payload)
        this.#onLog(2, `Sent file ${action} request to ${this.#session.remotePodId}: ${path}`)
      } catch (err) {
        clearTimeout(timer)
        this.#pendingRequests.delete(requestId)
        reject(err)
      }
    })
  }

  // -- Response handling (private) ------------------------------------------

  /**
   * Handle an incoming file response from the remote host.
   * Matches by requestId and resolves or rejects the pending promise.
   *
   * @param {object} envelope - Session envelope with payload
   */
  #handleResponse(envelope) {
    const payload = envelope.payload || envelope
    const { requestId } = payload

    if (!requestId) return

    const pending = this.#pendingRequests.get(requestId)
    if (!pending) return

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
   * Close the file client. Removes the handler from the session
   * and rejects all pending requests.
   */
  close() {
    // Reject all pending requests
    for (const [requestId, pending] of this.#pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(new Error('FileClient closed'))
    }
    this.#pendingRequests.clear()

    // Remove handler from session
    this.#session.removeHandler('files')
  }

  // -- Serialization --------------------------------------------------------

  /**
   * Serialize to a JSON-safe object.
   *
   * @returns {object}
   */
  toJSON() {
    return {
      sessionId: this.#session.sessionId,
      localPodId: this.#session.localPodId,
      remotePodId: this.#session.remotePodId,
      pendingRequests: this.#pendingRequests.size,
      timeout: this.#timeout,
    }
  }
}
