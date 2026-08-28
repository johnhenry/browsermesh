/**
// STATUS: EXPERIMENTAL — complete implementation, not yet integrated into main application
 * clawser-peer-collab.js -- Real-time collaborative editing via Yjs CRDT.
 *
 * YjsAdapter: wraps Yjs Doc with shared types and sync primitives.
 * AwarenessState: cursor/selection presence (custom, no Yjs awareness dep).
 * CollabSession: ties YjsAdapter + AwarenessState to a PeerSession.
 *
 * Yjs loaded via CDN: https://cdn.jsdelivr.net/npm/yjs@13.6.30/+esm
 *
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-peer-collab.test.mjs
 */

// ---------------------------------------------------------------------------
// Wire constants
// ---------------------------------------------------------------------------

export const COLLAB_UPDATE = 0xF0
export const COLLAB_AWARENESS = 0xF1
export const COLLAB_SYNC = 0xF2

// ---------------------------------------------------------------------------
// YjsAdapter
// ---------------------------------------------------------------------------

/**
 * Wraps a Yjs Doc for collaborative editing.
 * Accepts an injected Y module for testability (CDN loaded in browser).
 */
export class YjsAdapter {
  #doc
  #Y
  #updateCallbacks = []
  #destroyed = false

  /**
   * @param {string} docId - Document identifier
   * @param {object} [opts]
   * @param {object} [opts.Y] - Yjs module (injected for testing)
   */
  constructor(docId, opts = {}) {
    if (!docId || typeof docId !== 'string') {
      throw new Error('docId is required and must be a non-empty string')
    }
    this.docId = docId
    this.#Y = opts.Y || null

    if (this.#Y) {
      this.#doc = new this.#Y.Doc()
    } else {
      // Stub doc for when Y is not available
      this.#doc = this.#createStubDoc()
    }
  }

  get doc() { return this.#doc }
  get destroyed() { return this.#destroyed }

  /**
   * Get or create a shared Y.Text type.
   * @param {string} name
   * @returns {*} Y.Text or stub
   */
  getText(name) {
    if (this.#Y) return this.#doc.getText(name)
    return this.#doc._texts.get(name) || this.#doc._createText(name)
  }

  /**
   * Get or create a shared Y.Map type.
   * @param {string} name
   * @returns {*} Y.Map or stub
   */
  getMap(name) {
    if (this.#Y) return this.#doc.getMap(name)
    return this.#doc._maps.get(name) || this.#doc._createMap(name)
  }

  /**
   * Apply a binary update from a remote peer.
   * @param {Uint8Array} update
   */
  applyUpdate(update) {
    if (this.#destroyed) throw new Error('Adapter is destroyed')
    if (this.#Y) {
      this.#Y.applyUpdate(this.#doc, update)
    } else {
      // Stub: store raw update
      this.#doc._updates.push(update)
    }
  }

  /**
   * Encode the full document state as a binary snapshot.
   * @returns {Uint8Array}
   */
  encodeState() {
    if (this.#Y) {
      return this.#Y.encodeStateAsUpdate(this.#doc)
    }
    return new Uint8Array(this.#doc._updates.flat())
  }

  /**
   * Register a callback for document updates.
   * @param {Function} callback - (update: Uint8Array, origin: any) => void
   */
  onUpdate(callback) {
    this.#updateCallbacks.push(callback)
    if (this.#Y) {
      this.#doc.on('update', callback)
    }
  }

  /**
   * Destroy the adapter and release resources.
   */
  destroy() {
    if (this.#destroyed) return
    this.#destroyed = true
    if (this.#Y) {
      this.#doc.destroy()
    }
    this.#updateCallbacks = []
  }

  // -- Internal -------------------------------------------------------------

  /**
   * Create a stub doc for testing without Yjs.
   * @returns {object}
   */
  #createStubDoc() {
    const texts = new Map()
    const maps = new Map()
    const updates = []
    return {
      _texts: texts,
      _maps: maps,
      _updates: updates,
      _createText(name) {
        const t = {
          _content: '',
          insert(pos, str) {
            this._content = this._content.slice(0, pos) + str + this._content.slice(pos)
          },
          toString() { return this._content },
          delete(pos, len) {
            this._content = this._content.slice(0, pos) + this._content.slice(pos + len)
          },
          get length() { return this._content.length },
        }
        texts.set(name, t)
        return t
      },
      _createMap(name) {
        const m = {
          _data: new Map(),
          set(k, v) { this._data.set(k, v) },
          get(k) { return this._data.get(k) },
          delete(k) { this._data.delete(k) },
          has(k) { return this._data.has(k) },
          toJSON() { return Object.fromEntries(this._data) },
          get size() { return this._data.size },
        }
        maps.set(name, m)
        return m
      },
    }
  }
}

// ---------------------------------------------------------------------------
// AwarenessState
// ---------------------------------------------------------------------------

/**
 * Lightweight awareness/presence state for collaborative sessions.
 * Tracks cursor positions, selections, and user metadata without
 * depending on Yjs awareness protocol.
 */
export class AwarenessState {
  #localState = null
  #states = new Map() // peerId -> state
  #callbacks = []

  /**
   * Set the local user's awareness state.
   * @param {object} state - { cursor, selection, user, color, ... }
   */
  setLocal(state) {
    this.#localState = { ...state, updatedAt: Date.now() }
  }

  /**
   * Get the local state.
   * @returns {object|null}
   */
  getLocal() {
    return this.#localState ? { ...this.#localState } : null
  }

  /**
   * Update a remote peer's awareness state.
   * @param {string} peerId
   * @param {object} state
   */
  setRemote(peerId, state) {
    this.#states.set(peerId, { ...state, updatedAt: Date.now() })
    for (const cb of this.#callbacks) cb(peerId, state)
  }

  /**
   * Remove a peer's awareness state.
   * @param {string} peerId
   */
  removeRemote(peerId) {
    this.#states.delete(peerId)
  }

  /**
   * Get all awareness states (local + remote).
   * @returns {Map<string, object>}
   */
  getStates() {
    const result = new Map(this.#states)
    if (this.#localState) {
      result.set('local', this.#localState)
    }
    return result
  }

  /**
   * Register a callback for awareness updates.
   * @param {Function} cb - (peerId, state) => void
   */
  onUpdate(cb) {
    this.#callbacks.push(cb)
  }

  /**
   * Clear all remote states.
   */
  clear() {
    this.#states.clear()
  }
}

// ---------------------------------------------------------------------------
// CollabSession
// ---------------------------------------------------------------------------

/**
 * Ties a YjsAdapter + AwarenessState to a PeerSession for
 * real-time collaborative editing over the mesh network.
 */
export class CollabSession {
  #adapter
  #awareness
  #session
  #docId
  #active = false

  /**
   * @param {object} opts
   * @param {object} opts.session - PeerSession (or mock with send/onMessage)
   * @param {string} opts.docId - Document identifier
   * @param {object} [opts.Y] - Yjs module
   */
  constructor({ session, docId, Y }) {
    if (!session) throw new Error('session is required')
    if (!docId || typeof docId !== 'string') throw new Error('docId is required')

    this.#session = session
    this.#docId = docId
    this.#adapter = new YjsAdapter(docId, { Y })
    this.#awareness = new AwarenessState()
  }

  get adapter() { return this.#adapter }
  get awareness() { return this.#awareness }
  get docId() { return this.#docId }
  get active() { return this.#active }

  /**
   * Start the collab session -- register message handlers and
   * listen for doc updates to broadcast to peer.
   */
  start() {
    if (this.#active) return
    this.#active = true

    // Forward local doc updates to peer
    this.#adapter.onUpdate((update) => {
      if (this.#active && this.#session.send) {
        this.#session.send({
          type: COLLAB_UPDATE,
          docId: this.#docId,
          update: Array.from(update),
        })
      }
    })

    // Handle incoming messages
    if (this.#session.onMessage) {
      this.#session.onMessage((msg) => {
        if (!msg || msg.docId !== this.#docId) return

        if (msg.type === COLLAB_UPDATE && msg.update) {
          this.#adapter.applyUpdate(new Uint8Array(msg.update))
        } else if (msg.type === COLLAB_AWARENESS && msg.state) {
          this.#awareness.setRemote(msg.peerId || 'remote', msg.state)
        } else if (msg.type === COLLAB_SYNC) {
          // Full state sync request/response
          if (msg.state) {
            this.#adapter.applyUpdate(new Uint8Array(msg.state))
          }
        }
      })
    }
  }

  /**
   * Sync full state with peer (initial exchange).
   */
  syncWithPeer() {
    const state = this.#adapter.encodeState()
    if (this.#session.send) {
      this.#session.send({
        type: COLLAB_SYNC,
        docId: this.#docId,
        state: Array.from(state),
      })
    }
  }

  /**
   * Broadcast local awareness state to peer.
   * @param {object} state - Awareness data to share
   */
  broadcastAwareness(state) {
    this.#awareness.setLocal(state)
    if (this.#session.send) {
      this.#session.send({
        type: COLLAB_AWARENESS,
        docId: this.#docId,
        state,
      })
    }
  }

  /**
   * Close the collab session and clean up.
   */
  close() {
    this.#active = false
    this.#adapter.destroy()
    this.#awareness.clear()
  }
}
