/**
// STATUS: EXPERIMENTAL — wires peer-collab CRDT into mesh transport layer
 * clawser-peer-collab-bridge.js — Connects the CollabSession (Yjs CRDT)
 * and MeshSyncEngine to the PeerSession transport and SyncCoordinator.
 *
 * CollabBridge: per-peer adapter that bridges CollabSession's simple
 *   {send, onMessage} interface to PeerSession's handler-based routing.
 *
 * CollabManager: lifecycle manager that creates/destroys CollabBridges
 *   in response to peer:connect / peer:disconnect events and orchestrates
 *   document replication via MeshSyncEngine + SyncCoordinator.
 *
 * Usage (inside initMeshSubsystem):
 *   const collabManager = new CollabManager({
 *     syncEngine: state.syncEngine,
 *     syncCoordinator: state.syncCoordinator,
 *     sessionManager: state.sessionManager,
 *     localPodId: state.pod.podId,
 *   });
 *   collabManager.attach(peerNode);
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-peer-collab-bridge.test.mjs
 */

import {
  COLLAB_UPDATE,
  COLLAB_AWARENESS,
  COLLAB_SYNC,
  CollabSession,
} from './collab.mjs'

// ---------------------------------------------------------------------------
// Wire constants — service type strings used with PeerSession.registerHandler
// ---------------------------------------------------------------------------

/** Service type for collab updates routed through PeerSession. */
export const COLLAB_SERVICE_TYPE = 'collab'

/** Service type for CRDT sync-engine payloads routed through PeerSession. */
export const CRDT_SYNC_SERVICE_TYPE = 'crdt-sync'

// ---------------------------------------------------------------------------
// CollabBridge
// ---------------------------------------------------------------------------

/**
 * Adapts a PeerSession to the simple {send, onMessage} interface that
 * CollabSession expects. Also bridges MeshSyncEngine document sync
 * payloads over the same PeerSession.
 *
 * One CollabBridge per connected peer.
 */
export class CollabBridge {
  /** @type {import('./clawser-peer-session.js').PeerSession} */
  #peerSession

  /** @type {Map<string, CollabSession>} docId -> CollabSession */
  #collabSessions = new Map()

  /** @type {import('./clawser-mesh-sync.js').MeshSyncEngine|null} */
  #syncEngine

  /** @type {import('./clawser-mesh-delta-sync.js').SyncCoordinator|null} */
  #syncCoordinator

  /** @type {string} */
  #remotePodId

  /** @type {Function[]} */
  #messageCallbacks = []

  /** @type {boolean} */
  #destroyed = false

  /** @type {Function} */
  #onLog

  /**
   * @param {object} opts
   * @param {import('./clawser-peer-session.js').PeerSession} opts.peerSession
   * @param {import('./clawser-mesh-sync.js').MeshSyncEngine} [opts.syncEngine]
   * @param {import('./clawser-mesh-delta-sync.js').SyncCoordinator} [opts.syncCoordinator]
   * @param {Function} [opts.onLog]
   */
  constructor({ peerSession, syncEngine, syncCoordinator, onLog }) {
    if (!peerSession) throw new Error('peerSession is required')
    this.#peerSession = peerSession
    this.#remotePodId = peerSession.remotePodId
    this.#syncEngine = syncEngine || null
    this.#syncCoordinator = syncCoordinator || null
    this.#onLog = onLog || (() => {})

    // Register handler for incoming collab messages on the PeerSession
    this.#peerSession.registerHandler(COLLAB_SERVICE_TYPE, (envelope) => {
      const msg = envelope.payload || envelope
      if (!msg) return
      // Dispatch to all registered message callbacks (CollabSession listeners)
      for (const cb of this.#messageCallbacks) {
        try { cb(msg) } catch { /* listener errors don't propagate */ }
      }
    })

    // Register handler for CRDT sync-engine payloads
    this.#peerSession.registerHandler(CRDT_SYNC_SERVICE_TYPE, (envelope) => {
      const payload = envelope.payload || envelope
      if (!payload) return
      this.#handleCrdtSync(payload)
    })
  }

  /** Remote peer's pod ID. */
  get remotePodId() { return this.#remotePodId }

  /** Whether this bridge has been destroyed. */
  get destroyed() { return this.#destroyed }

  /** Number of active collab sessions on this bridge. */
  get sessionCount() { return this.#collabSessions.size }

  // -- PeerSession-to-CollabSession adapter ---------------------------------

  /**
   * Create the {send, onMessage} adapter object that CollabSession expects.
   * @returns {{ send: Function, onMessage: Function }}
   */
  #createSessionAdapter() {
    return {
      send: (msg) => {
        if (this.#destroyed) return
        try {
          this.#peerSession.send(COLLAB_SERVICE_TYPE, msg)
        } catch (err) {
          this.#onLog(0, `CollabBridge send error: ${err.message}`)
        }
      },
      onMessage: (cb) => {
        this.#messageCallbacks.push(cb)
      },
    }
  }

  // -- Collab session management --------------------------------------------

  /**
   * Open a collaborative editing session for a document.
   * Creates a CollabSession backed by the PeerSession transport.
   *
   * @param {string} docId - Document identifier
   * @param {object} [opts]
   * @param {object} [opts.Y] - Yjs module (for real Y.js integration)
   * @returns {CollabSession}
   */
  openDocument(docId, opts = {}) {
    if (this.#destroyed) throw new Error('Bridge is destroyed')
    if (this.#collabSessions.has(docId)) {
      return this.#collabSessions.get(docId)
    }

    const adapter = this.#createSessionAdapter()
    const collab = new CollabSession({
      session: adapter,
      docId,
      Y: opts.Y,
    })
    collab.start()

    this.#collabSessions.set(docId, collab)
    this.#onLog(2, `Opened collab session for doc "${docId}" with peer ${this.#remotePodId}`)

    // Sync initial state
    collab.syncWithPeer()

    return collab
  }

  /**
   * Close a collaborative editing session for a document.
   * @param {string} docId
   */
  closeDocument(docId) {
    const collab = this.#collabSessions.get(docId)
    if (!collab) return
    collab.close()
    this.#collabSessions.delete(docId)
    this.#onLog(2, `Closed collab session for doc "${docId}" with peer ${this.#remotePodId}`)
  }

  /**
   * Get an open collab session by docId.
   * @param {string} docId
   * @returns {CollabSession|null}
   */
  getDocument(docId) {
    return this.#collabSessions.get(docId) || null
  }

  /**
   * List all open document IDs on this bridge.
   * @returns {string[]}
   */
  listDocuments() {
    return [...this.#collabSessions.keys()]
  }

  // -- CRDT Sync Engine bridge ----------------------------------------------

  /**
   * Push a MeshSyncEngine document's state to the remote peer.
   * @param {string} docId - Document ID in the MeshSyncEngine
   */
  pushSyncDocument(docId) {
    if (this.#destroyed || !this.#syncEngine) return

    const payload = this.#syncEngine.prepareSyncPayload(docId)
    if (!payload) {
      this.#onLog(1, `No sync payload for doc "${docId}"`)
      return
    }

    try {
      this.#peerSession.send(CRDT_SYNC_SERVICE_TYPE, {
        action: 'sync',
        docId,
        ...payload,
      })
    } catch (err) {
      this.#onLog(0, `CRDT sync push error: ${err.message}`)
    }
  }

  /**
   * Request a delta sync from the SyncCoordinator for this peer.
   */
  requestDeltaSync() {
    if (this.#destroyed || !this.#syncCoordinator) return

    try {
      this.#syncCoordinator.requestSync(this.#remotePodId)
    } catch (err) {
      this.#onLog(0, `Delta sync request error: ${err.message}`)
    }
  }

  /**
   * Push all MeshSyncEngine documents to the remote peer.
   */
  pushAllSyncDocuments() {
    if (this.#destroyed || !this.#syncEngine) return

    for (const doc of this.#syncEngine.listDocuments()) {
      this.pushSyncDocument(doc.id)
    }
  }

  /**
   * Handle an incoming CRDT sync payload from the remote peer.
   * @param {object} payload
   */
  #handleCrdtSync(payload) {
    if (!payload || !payload.docId) return

    if (payload.action === 'sync' && this.#syncEngine) {
      // Merge remote CRDT state into local MeshSyncEngine document
      const localDoc = this.#syncEngine.get(payload.docId)
      if (localDoc) {
        try {
          this.#syncEngine.merge(payload.docId, {
            crdt: payload.crdt,
            version: payload.version,
          })
          this.#onLog(2, `Merged CRDT doc "${payload.docId}" from peer ${this.#remotePodId}`)
        } catch (err) {
          this.#onLog(0, `CRDT merge error for "${payload.docId}": ${err.message}`)
        }
      } else {
        this.#onLog(1, `Received sync for unknown doc "${payload.docId}" — ignoring`)
      }
    }

    if (payload.action === 'delta' && this.#syncCoordinator) {
      // Handle delta sync messages through the SyncCoordinator wire protocol
      try {
        this.#syncCoordinator.handleMessage(this.#remotePodId, payload.message)
        this.#onLog(2, `Applied delta sync from peer ${this.#remotePodId}`)
      } catch (err) {
        this.#onLog(0, `Delta sync error from ${this.#remotePodId}: ${err.message}`)
      }
    }
  }

  // -- Lifecycle ------------------------------------------------------------

  /**
   * Destroy the bridge — close all collab sessions, remove handlers.
   */
  destroy() {
    if (this.#destroyed) return
    this.#destroyed = true

    // Close all collab sessions
    for (const [docId, collab] of this.#collabSessions) {
      try { collab.close() } catch { /* best effort */ }
    }
    this.#collabSessions.clear()

    // Remove PeerSession handlers
    try { this.#peerSession.removeHandler(COLLAB_SERVICE_TYPE) } catch { /* */ }
    try { this.#peerSession.removeHandler(CRDT_SYNC_SERVICE_TYPE) } catch { /* */ }

    this.#messageCallbacks = []
    this.#onLog(2, `CollabBridge destroyed for peer ${this.#remotePodId}`)
  }

  /**
   * Serialize bridge state.
   * @returns {object}
   */
  toJSON() {
    return {
      remotePodId: this.#remotePodId,
      destroyed: this.#destroyed,
      documents: [...this.#collabSessions.keys()],
    }
  }
}

// ---------------------------------------------------------------------------
// CollabManager
// ---------------------------------------------------------------------------

/**
 * Lifecycle manager for CollabBridges. Hooks into PeerNode events to
 * automatically create/destroy bridges when peers connect/disconnect.
 *
 * Also provides an API for opening/closing collaborative documents that
 * automatically replicates across all connected peers.
 */
export class CollabManager {
  /** @type {Map<string, CollabBridge>} remotePodId -> CollabBridge */
  #bridges = new Map()

  /** @type {import('./clawser-mesh-sync.js').MeshSyncEngine|null} */
  #syncEngine

  /** @type {import('./clawser-mesh-delta-sync.js').SyncCoordinator|null} */
  #syncCoordinator

  /** @type {import('./clawser-peer-session.js').SessionManager|null} */
  #sessionManager

  /** @type {string} */
  #localPodId

  /** @type {Set<string>} docIds that should be auto-opened on new peers */
  #sharedDocuments = new Set()

  /** @type {Map<string, Function>} docId -> unsubscribe fn from MeshSyncEngine */
  #syncSubscriptions = new Map()

  /** @type {Function} */
  #onLog

  /** @type {object|null} reference to the attached PeerNode */
  #peerNode = null

  /** @type {Function|null} bound connect handler for cleanup */
  #boundConnect = null

  /** @type {Function|null} bound disconnect handler for cleanup */
  #boundDisconnect = null

  /**
   * @param {object} opts
   * @param {string} opts.localPodId
   * @param {import('./clawser-mesh-sync.js').MeshSyncEngine} [opts.syncEngine]
   * @param {import('./clawser-mesh-delta-sync.js').SyncCoordinator} [opts.syncCoordinator]
   * @param {import('./clawser-peer-session.js').SessionManager} [opts.sessionManager]
   * @param {Function} [opts.onLog]
   */
  constructor({ localPodId, syncEngine, syncCoordinator, sessionManager, onLog }) {
    if (!localPodId || typeof localPodId !== 'string') {
      throw new Error('localPodId is required')
    }
    this.#localPodId = localPodId
    this.#syncEngine = syncEngine || null
    this.#syncCoordinator = syncCoordinator || null
    this.#sessionManager = sessionManager || null
    this.#onLog = onLog || (() => {})
  }

  /** Number of active bridges. */
  get bridgeCount() { return this.#bridges.size }

  /** Local pod ID. */
  get localPodId() { return this.#localPodId }

  // -- PeerNode attachment ---------------------------------------------------

  /**
   * Attach to a PeerNode to auto-manage bridges on peer lifecycle events.
   *
   * @param {import('./clawser-peer-node.js').PeerNode} peerNode
   */
  attach(peerNode) {
    if (this.#peerNode) this.detach()

    this.#peerNode = peerNode

    this.#boundConnect = (peer) => {
      const peerId = peer?.fingerprint || peer?.podId || peer?.pubKey
      if (!peerId) return
      this.#onPeerConnect(peerId)
    }

    this.#boundDisconnect = (peer) => {
      const peerId = peer?.fingerprint || peer?.podId || peer?.pubKey
      if (!peerId) return
      this.#onPeerDisconnect(peerId)
    }

    peerNode.on('peer:connect', this.#boundConnect)
    peerNode.on('peer:disconnect', this.#boundDisconnect)

    this.#onLog(2, `CollabManager attached to PeerNode`)
  }

  /**
   * Detach from the PeerNode. Stops listening for lifecycle events.
   */
  detach() {
    if (this.#peerNode && this.#boundConnect) {
      this.#peerNode.off('peer:connect', this.#boundConnect)
    }
    if (this.#peerNode && this.#boundDisconnect) {
      this.#peerNode.off('peer:disconnect', this.#boundDisconnect)
    }
    this.#peerNode = null
    this.#boundConnect = null
    this.#boundDisconnect = null
  }

  // -- Peer lifecycle handlers -----------------------------------------------

  /**
   * Handle a new peer connection. Looks up the PeerSession from the
   * SessionManager, creates a CollabBridge, and opens any shared documents.
   *
   * @param {string} peerId
   */
  #onPeerConnect(peerId) {
    if (this.#bridges.has(peerId)) return

    // Find a PeerSession for this peer
    const peerSession = this.#findPeerSession(peerId)
    if (!peerSession) {
      this.#onLog(1, `No PeerSession found for peer ${peerId} — skipping collab bridge`)
      return
    }

    const bridge = new CollabBridge({
      peerSession,
      syncEngine: this.#syncEngine,
      syncCoordinator: this.#syncCoordinator,
      onLog: this.#onLog,
    })

    this.#bridges.set(peerId, bridge)
    this.#onLog(2, `CollabBridge created for peer ${peerId}`)

    // Auto-open any shared documents
    for (const docId of this.#sharedDocuments) {
      bridge.openDocument(docId)
    }

    // Push all sync engine documents to new peer
    bridge.pushAllSyncDocuments()
  }

  /**
   * Handle a peer disconnection. Destroys the CollabBridge.
   *
   * @param {string} peerId
   */
  #onPeerDisconnect(peerId) {
    const bridge = this.#bridges.get(peerId)
    if (!bridge) return

    bridge.destroy()
    this.#bridges.delete(peerId)
    this.#onLog(2, `CollabBridge destroyed for peer ${peerId}`)
  }

  /**
   * Find a PeerSession for a given peer ID. Checks the SessionManager first,
   * falls back to direct PeerNode session lookup.
   *
   * @param {string} peerId
   * @returns {import('./clawser-peer-session.js').PeerSession|null}
   */
  #findPeerSession(peerId) {
    // Try SessionManager first (provides full PeerSession with handler routing)
    if (this.#sessionManager) {
      const sessions = this.#sessionManager.getSessionsForPeer(peerId)
      if (sessions.length > 0) {
        return sessions[0]
      }
    }
    return null
  }

  // -- Document management ---------------------------------------------------

  /**
   * Share a document across all connected peers. Opens a CollabSession
   * on every existing bridge and marks the document for auto-open on
   * future peer connections.
   *
   * @param {string} docId
   * @param {object} [opts]
   * @param {object} [opts.Y] - Yjs module
   * @returns {Map<string, CollabSession>} peerId -> CollabSession
   */
  shareDocument(docId, opts = {}) {
    this.#sharedDocuments.add(docId)
    const sessions = new Map()

    for (const [peerId, bridge] of this.#bridges) {
      const collab = bridge.openDocument(docId, opts)
      sessions.set(peerId, collab)
    }

    // If the document exists in the sync engine, subscribe to updates
    // and push changes to all peers automatically
    if (this.#syncEngine && this.#syncEngine.get(docId)) {
      this.#subscribeSyncDocument(docId)
    }

    this.#onLog(2, `Document "${docId}" shared across ${sessions.size} peer(s)`)
    return sessions
  }

  /**
   * Unshare a document. Closes all CollabSessions for it.
   *
   * @param {string} docId
   */
  unshareDocument(docId) {
    this.#sharedDocuments.delete(docId)

    for (const [, bridge] of this.#bridges) {
      bridge.closeDocument(docId)
    }

    // Unsubscribe from sync engine updates
    const unsub = this.#syncSubscriptions.get(docId)
    if (unsub) {
      unsub()
      this.#syncSubscriptions.delete(docId)
    }

    this.#onLog(2, `Document "${docId}" unshared`)
  }

  /**
   * Subscribe to MeshSyncEngine document changes and push them to all peers.
   * @param {string} docId
   */
  #subscribeSyncDocument(docId) {
    if (this.#syncSubscriptions.has(docId)) return
    if (!this.#syncEngine) return

    const unsub = this.#syncEngine.subscribe(docId, () => {
      // On any local change, push updated state to all peers
      for (const [, bridge] of this.#bridges) {
        bridge.pushSyncDocument(docId)
      }
    })

    this.#syncSubscriptions.set(docId, unsub)
  }

  /**
   * Get the CollabBridge for a specific peer.
   * @param {string} peerId
   * @returns {CollabBridge|null}
   */
  getBridge(peerId) {
    return this.#bridges.get(peerId) || null
  }

  /**
   * List all peer IDs with active bridges.
   * @returns {string[]}
   */
  listPeers() {
    return [...this.#bridges.keys()]
  }

  /**
   * List all shared document IDs.
   * @returns {string[]}
   */
  listSharedDocuments() {
    return [...this.#sharedDocuments]
  }

  /**
   * Push a specific sync-engine document to all peers.
   * @param {string} docId
   */
  broadcastSyncDocument(docId) {
    for (const [, bridge] of this.#bridges) {
      bridge.pushSyncDocument(docId)
    }
  }

  /**
   * Request a delta sync from the SyncCoordinator for all peers.
   */
  requestDeltaSyncAll() {
    for (const [, bridge] of this.#bridges) {
      bridge.requestDeltaSync()
    }
  }

  // -- Lifecycle ------------------------------------------------------------

  /**
   * Destroy the manager — detach from PeerNode, destroy all bridges,
   * unsubscribe from sync engine.
   */
  destroy() {
    this.detach()

    for (const [, bridge] of this.#bridges) {
      bridge.destroy()
    }
    this.#bridges.clear()

    for (const [, unsub] of this.#syncSubscriptions) {
      try { unsub() } catch { /* best effort */ }
    }
    this.#syncSubscriptions.clear()
    this.#sharedDocuments.clear()

    this.#onLog(2, `CollabManager destroyed`)
  }

  /**
   * Serialize manager state.
   * @returns {object}
   */
  toJSON() {
    return {
      localPodId: this.#localPodId,
      bridges: [...this.#bridges.entries()].map(([k, v]) => ({ peerId: k, ...v.toJSON() })),
      sharedDocuments: [...this.#sharedDocuments],
    }
  }
}
