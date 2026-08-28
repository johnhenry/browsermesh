/**
// STATUS: INTEGRATED — wired into ClawserPod lifecycle, proven via E2E testing
 * Clawser Mesh Files
 *
 * Content-addressed file transfer with SHA-256 chunking, progress tracking,
 * and resume support. Builds on the streams module for transport.
 *
 * @module clawser-mesh-files
 */

import { MESH_TYPE, MESH_ERROR } from '@johnhenry/browsermesh-primitives';

// ── Constants ────────────────────────────────────────────────────────

export const TRANSFER_STATES = Object.freeze([
  'offered', 'accepted', 'transferring', 'completed', 'failed', 'cancelled',
]);

export const TRANSFER_DEFAULTS = Object.freeze({
  chunkSize: 256 * 1024,
  maxConcurrentChunks: 16,
  offerExpiry: 5 * 60 * 1000,
  resumeTimeout: 30 * 60 * 1000,
});

// ── Helpers ──────────────────────────────────────────────────────────

let _transferIdCounter = 0;

function generateTransferId() {
  return `xfer_${Date.now().toString(36)}_${(++_transferIdCounter).toString(36)}`;
}

// ── FileDescriptor ───────────────────────────────────────────────────

/**
 * Describes a file to be transferred.
 */
export class FileDescriptor {
  constructor({ name, size, mimeType, cid }) {
    if (!name || typeof name !== 'string') throw new Error('FileDescriptor requires a name');
    if (typeof size !== 'number' || size < 0) throw new Error('FileDescriptor requires a non-negative size');
    this.name = name;
    this.size = size;
    this.mimeType = mimeType || null;
    this.cid = cid || null;
  }

  toJSON() {
    return { name: this.name, size: this.size, mimeType: this.mimeType, cid: this.cid };
  }

  static fromJSON(json) {
    return new FileDescriptor(json);
  }
}

// ── TransferOffer ────────────────────────────────────────────────────

/**
 * A transfer offer from sender to recipient.
 */
export class TransferOffer {
  constructor({ transferId, sender, recipient, files, totalSize, expires }) {
    this.transferId = transferId || generateTransferId();
    this.sender = sender;
    this.recipient = recipient;
    this.files = (files || []).map(f => f instanceof FileDescriptor ? f : new FileDescriptor(f));
    this.totalSize = totalSize ?? this.files.reduce((sum, f) => sum + f.size, 0);
    this.expires = expires ?? (Date.now() + TRANSFER_DEFAULTS.offerExpiry);
  }

  isExpired(now) {
    return (now ?? Date.now()) >= this.expires;
  }

  toJSON() {
    return {
      transferId: this.transferId,
      sender: this.sender,
      recipient: this.recipient,
      files: this.files.map(f => f.toJSON()),
      totalSize: this.totalSize,
      expires: this.expires,
    };
  }

  static fromJSON(json) {
    return new TransferOffer({
      ...json,
      files: json.files.map(f => FileDescriptor.fromJSON(f)),
    });
  }
}

// ── ChunkStore ───────────────────────────────────────────────────────

/**
 * In-memory content-addressed storage for file chunks.
 * CIDs are SHA-256 hex strings.
 */
export class ChunkStore {
  #chunks = new Map();

  /**
   * Compute a content ID (SHA-256 hex) for data.
   * @param {Uint8Array} data
   * @returns {Promise<string>}
   */
  static async computeCid(data) {
    let hash;
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      hash = await crypto.subtle.digest('SHA-256', data);
    } else {
      // Node.js fallback
      const { createHash } = await import('node:crypto');
      const h = createHash('sha256');
      h.update(data);
      hash = h.digest().buffer;
    }
    return Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Store a chunk by its CID.
   * @param {string} cid
   * @param {Uint8Array} data
   */
  save(cid, data) {
    this.#chunks.set(cid, data);
  }

  /**
   * Retrieve a chunk by CID.
   * @param {string} cid
   * @returns {Uint8Array|undefined}
   */
  get(cid) {
    return this.#chunks.get(cid);
  }

  /**
   * Check if a chunk exists.
   * @param {string} cid
   * @returns {boolean}
   */
  has(cid) {
    return this.#chunks.has(cid);
  }

  /**
   * Verify that data matches the expected CID.
   * @param {string} cid
   * @param {Uint8Array} data
   * @returns {Promise<boolean>}
   */
  async verify(cid, data) {
    const computed = await ChunkStore.computeCid(data);
    return computed === cid;
  }

  /**
   * Remove a chunk by CID.
   * @param {string} cid
   * @returns {boolean}
   */
  remove(cid) {
    return this.#chunks.delete(cid);
  }

  /** Number of stored chunks. */
  get size() { return this.#chunks.size; }

  /** Clear all chunks. */
  clear() { this.#chunks.clear(); }
}

// ── TransferState ────────────────────────────────────────────────────

/**
 * Progress tracker for a single file transfer.
 */
export class TransferState {
  #transferId;
  #status;
  #totalSize;
  #bytesTransferred = 0;
  #chunks = []; // { fileIndex, cid, size }
  #startedAt = null;
  #completedAt = null;
  #fileChunks = new Map(); // fileIndex → Set<cid>
  #fileSizes;

  constructor({ transferId, totalSize, status, fileSizes }) {
    this.#transferId = transferId;
    this.#totalSize = totalSize;
    this.#status = status || 'offered';
    this.#fileSizes = fileSizes || [];
  }

  get transferId() { return this.#transferId; }
  get status() { return this.#status; }
  set status(s) {
    if (!TRANSFER_STATES.includes(s)) throw new Error(`Invalid transfer status: ${s}`);
    this.#status = s;
    if (s === 'transferring' && !this.#startedAt) this.#startedAt = Date.now();
    if (s === 'completed' || s === 'failed' || s === 'cancelled') this.#completedAt = Date.now();
  }
  get totalSize() { return this.#totalSize; }
  get bytesTransferred() { return this.#bytesTransferred; }

  get percentComplete() {
    if (this.#totalSize === 0) return 100;
    return Math.min(100, (this.#bytesTransferred / this.#totalSize) * 100);
  }

  get transferRate() {
    if (!this.#startedAt) return 0;
    const elapsed = ((this.#completedAt || Date.now()) - this.#startedAt) / 1000;
    if (elapsed <= 0) return 0;
    return this.#bytesTransferred / elapsed;
  }

  /**
   * Record a received chunk.
   * @param {number} fileIndex
   * @param {string} cid
   * @param {number} size
   */
  addChunk(fileIndex, cid, size) {
    if (this.#status !== 'transferring') {
      this.status = 'transferring';
    }
    if (!this.#fileChunks.has(fileIndex)) {
      this.#fileChunks.set(fileIndex, new Set());
    }
    const fileSet = this.#fileChunks.get(fileIndex);
    if (fileSet.has(cid)) return; // Deduplicate
    fileSet.add(cid);
    this.#bytesTransferred += size;
    this.#chunks.push({ fileIndex, cid, size });
  }

  /**
   * Check if the transfer is complete (all bytes received).
   * @returns {boolean}
   */
  isComplete() {
    return this.#bytesTransferred >= this.#totalSize;
  }

  /**
   * Get chunk CIDs already received for a specific file.
   * @param {number} fileIndex
   * @returns {Set<string>}
   */
  getReceivedChunks(fileIndex) {
    return this.#fileChunks.get(fileIndex) || new Set();
  }

  toJSON() {
    const fileChunks = {};
    for (const [idx, cids] of this.#fileChunks) {
      fileChunks[idx] = [...cids];
    }
    return {
      transferId: this.#transferId,
      status: this.#status,
      totalSize: this.#totalSize,
      bytesTransferred: this.#bytesTransferred,
      percentComplete: this.percentComplete,
      transferRate: this.transferRate,
      chunks: this.#chunks,
      fileChunks,
      startedAt: this.#startedAt,
      completedAt: this.#completedAt,
    };
  }
}

// ── MeshFileTransfer ─────────────────────────────────────────────────

/**
 * Top-level file transfer manager. Handles offers, acceptance, chunked
 * sending/receiving, and progress tracking.
 */
export class MeshFileTransfer {
  /** @type {Map<string, TransferOffer>} transferId → offer */
  #offers = new Map();

  /** @type {Map<string, TransferState>} transferId → state */
  #states = new Map();

  /** @type {ChunkStore} */
  #store;

  #chunkSize;

  // Callbacks
  #onOffer = null;
  #onProgress = null;
  #onComplete = null;
  #onSend = null;

  constructor(opts = {}) {
    this.#store = opts.store || new ChunkStore();
    this.#chunkSize = opts.chunkSize ?? TRANSFER_DEFAULTS.chunkSize;
  }

  // ── Callbacks ────────────────────────────────────────────────────

  onOffer(cb) { this.#onOffer = cb; return this; }
  onProgress(cb) { this.#onProgress = cb; return this; }
  onComplete(cb) { this.#onComplete = cb; return this; }
  onSend(cb) { this.#onSend = cb; return this; }

  /** Access the chunk store. */
  get store() { return this.#store; }

  // ── Create / Accept / Reject ─────────────────────────────────────

  /**
   * Create a transfer offer.
   * @param {string} recipient - Recipient identity
   * @param {Array<{name, size, mimeType?}>} files
   * @param {object} [opts]
   * @returns {TransferOffer}
   */
  createOffer(recipient, files, opts = {}) {
    const offer = new TransferOffer({
      sender: opts.sender || 'local',
      recipient,
      files,
      expires: opts.expires,
    });
    this.#offers.set(offer.transferId, offer);
    const fileSizes = offer.files.map(f => f.size);
    const state = new TransferState({
      transferId: offer.transferId,
      totalSize: offer.totalSize,
      status: 'offered',
      fileSizes,
    });
    this.#states.set(offer.transferId, state);

    this._emit({
      t: MESH_TYPE.FILE_OFFER,
      p: offer.toJSON(),
    });

    return offer;
  }

  /**
   * Accept an incoming transfer offer.
   * @param {TransferOffer|object} offer
   * @returns {TransferState}
   */
  acceptOffer(offer) {
    if (!(offer instanceof TransferOffer)) {
      offer = TransferOffer.fromJSON(offer);
    }
    if (offer.isExpired()) {
      throw new Error('Transfer offer has expired');
    }
    this.#offers.set(offer.transferId, offer);
    const fileSizes = offer.files.map(f => f.size);
    const state = new TransferState({
      transferId: offer.transferId,
      totalSize: offer.totalSize,
      status: 'accepted',
      fileSizes,
    });
    this.#states.set(offer.transferId, state);

    this._emit({
      t: MESH_TYPE.FILE_ACCEPT,
      p: { transferId: offer.transferId },
    });

    return state;
  }

  /**
   * Reject an incoming transfer offer.
   * @param {string} transferId
   * @param {string} [reason]
   */
  rejectOffer(transferId, reason) {
    const offer = this.#offers.get(transferId);
    if (offer) {
      this.#offers.delete(transferId);
    }
    const state = this.#states.get(transferId);
    if (state) {
      state.status = 'cancelled';
    }

    this._emit({
      t: MESH_TYPE.FILE_REJECT,
      p: { transferId, reason: reason || 'Rejected by recipient' },
    });
  }

  // ── Sending ──────────────────────────────────────────────────────

  /**
   * Generate chunks for sending. Yields chunk descriptors.
   * @param {string} transferId
   * @param {Array<Uint8Array>} fileData - File contents in order
   * @returns {Generator<{cid: string, data: Uint8Array, fileIndex: number, offset: number}>}
   */
  async *sendChunks(transferId, fileData) {
    const offer = this.#offers.get(transferId);
    if (!offer) throw new Error(`Unknown transfer: ${transferId}`);
    const state = this.#states.get(transferId);
    if (!state) throw new Error(`No state for transfer: ${transferId}`);

    state.status = 'transferring';

    for (let fileIndex = 0; fileIndex < fileData.length; fileIndex++) {
      const data = fileData[fileIndex];
      for (let offset = 0; offset < data.length; offset += this.#chunkSize) {
        const chunk = data.subarray(offset, Math.min(offset + this.#chunkSize, data.length));
        const cid = await ChunkStore.computeCid(chunk);
        this.#store.save(cid, chunk);
        state.addChunk(fileIndex, cid, chunk.length);

        this._emitProgress(transferId, state);

        yield { cid, data: chunk, fileIndex, offset };
      }
    }

    if (state.isComplete()) {
      state.status = 'completed';
      this._emit({
        t: MESH_TYPE.FILE_COMPLETE,
        p: { transferId },
      });
      if (this.#onComplete) this.#onComplete(transferId, state);
    }
  }

  // ── Receiving ────────────────────────────────────────────────────

  /**
   * Receive and validate a chunk.
   * @param {string} transferId
   * @param {number} fileIndex
   * @param {string} cid
   * @param {Uint8Array} data
   * @returns {Promise<boolean>}
   */
  async receiveChunk(transferId, fileIndex, cid, data) {
    const state = this.#states.get(transferId);
    if (!state) throw new Error(`Unknown transfer: ${transferId}`);

    // Verify integrity
    const valid = await this.#store.verify(cid, data);
    if (!valid) {
      return false;
    }

    this.#store.save(cid, data);
    state.addChunk(fileIndex, cid, data.length);

    this._emitProgress(transferId, state);

    if (state.isComplete()) {
      state.status = 'completed';
      this._emit({
        t: MESH_TYPE.FILE_COMPLETE,
        p: { transferId },
      });
      if (this.#onComplete) this.#onComplete(transferId, state);
    }

    return true;
  }

  // ── Query ────────────────────────────────────────────────────────

  /**
   * Get a transfer state by ID.
   * @param {string} transferId
   * @returns {TransferState|undefined}
   */
  getTransfer(transferId) {
    return this.#states.get(transferId);
  }

  /**
   * Get a transfer offer by ID.
   * @param {string} transferId
   * @returns {TransferOffer|undefined}
   */
  getOffer(transferId) {
    return this.#offers.get(transferId);
  }

  /**
   * List transfers, optionally filtered.
   * @param {object} [filter]
   * @param {string} [filter.status]
   * @param {string} [filter.peerId]
   * @returns {Array<{offer: object, state: object}>}
   */
  listTransfers(filter) {
    const results = [];
    for (const [id, state] of this.#states) {
      if (filter?.status && state.status !== filter.status) continue;
      const offer = this.#offers.get(id);
      if (filter?.peerId && offer) {
        if (offer.sender !== filter.peerId && offer.recipient !== filter.peerId) continue;
      }
      results.push({
        offer: offer ? offer.toJSON() : null,
        state: state.toJSON(),
      });
    }
    return results;
  }

  /**
   * Cancel an in-progress transfer.
   * @param {string} transferId
   * @param {string} [reason]
   */
  cancelTransfer(transferId, reason) {
    const state = this.#states.get(transferId);
    if (state && state.status !== 'completed' && state.status !== 'failed' && state.status !== 'cancelled') {
      state.status = 'cancelled';
    }

    this._emit({
      t: MESH_TYPE.FILE_CANCEL,
      p: { transferId, reason: reason || 'Cancelled' },
    });
  }

  // ── Dispatch inbound messages ────────────────────────────────────

  /**
   * Handle an inbound file transfer message.
   * @param {object} msg
   */
  dispatch(msg) {
    if (!msg) return;

    // Accept envelope format { _mesh: 'file-transfer', payload: {t, p} }
    if (msg._mesh && msg.payload) {
      msg = msg.payload;
    }

    if (!msg.p) return;

    switch (msg.t) {
      case MESH_TYPE.FILE_OFFER: {
        const offer = TransferOffer.fromJSON(msg.p);
        this.#offers.set(offer.transferId, offer);
        if (this.#onOffer) this.#onOffer(offer);
        break;
      }
      case MESH_TYPE.FILE_ACCEPT: {
        const state = this.#states.get(msg.p.transferId);
        if (state) state.status = 'accepted';
        break;
      }
      case MESH_TYPE.FILE_REJECT: {
        const state = this.#states.get(msg.p.transferId);
        if (state) state.status = 'cancelled';
        this.#offers.delete(msg.p.transferId);
        break;
      }
      case MESH_TYPE.FILE_COMPLETE: {
        const state = this.#states.get(msg.p.transferId);
        if (state) state.status = 'completed';
        if (this.#onComplete) this.#onComplete(msg.p.transferId, state);
        break;
      }
      case MESH_TYPE.FILE_CANCEL: {
        const state = this.#states.get(msg.p.transferId);
        if (state && state.status !== 'completed') state.status = 'cancelled';
        break;
      }
    }
  }

  // ── Internal ─────────────────────────────────────────────────────

  _emit(msg) {
    if (this.#onSend) this.#onSend(msg);
  }

  _emitProgress(transferId, state) {
    if (this.#onProgress) {
      this.#onProgress(transferId, {
        bytesTransferred: state.bytesTransferred,
        totalSize: state.totalSize,
        percentComplete: state.percentComplete,
        transferRate: state.transferRate,
      });
    }
    this._emit({
      t: MESH_TYPE.FILE_PROGRESS,
      p: {
        transferId,
        bytesTransferred: state.bytesTransferred,
        totalSize: state.totalSize,
        percentComplete: state.percentComplete,
      },
    });
  }

  // ── Serialization ────────────────────────────────────────────────

  toJSON() {
    const offers = {};
    for (const [id, offer] of this.#offers) {
      offers[id] = offer.toJSON();
    }
    const states = {};
    for (const [id, state] of this.#states) {
      states[id] = state.toJSON();
    }
    return { offers, states };
  }

  static fromJSON(json, opts = {}) {
    const ft = new MeshFileTransfer(opts);
    for (const [id, data] of Object.entries(json.offers || {})) {
      ft.#offers.set(id, TransferOffer.fromJSON(data));
    }
    // States need to be reconstructed (TransferState doesn't have fromJSON yet — use toJSON data for reference)
    return ft;
  }
}
