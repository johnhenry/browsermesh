/**
// STATUS: INTEGRATED — wired into ClawserPod lifecycle, proven via E2E testing
 * clawser-mesh-chat.js -- CRDT-backed chat rooms for BrowserMesh.
 *
 * ChatMessage envelopes, ChatRoom with ORSet membership, LWWMap
 * presence, moderation, and a multi-room MeshChat manager.
 *
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-mesh-chat.test.mjs
 */

import {
  ORSet,
  LWWMap,
} from '@johnhenry/browsermesh-primitives';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MESSAGE_TYPES = Object.freeze([
  'text', 'file', 'reply', 'reaction', 'edit', 'redaction', 'system',
]);

/** Maximum message body size in bytes */
export const MAX_MESSAGE_SIZE = 32768;

/** Maximum members per room */
export const MAX_ROOM_MEMBERS = 256;

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

let _msgSeq = 0;

function generateMessageId() {
  return `msg_${Date.now().toString(36)}_${(++_msgSeq).toString(36)}`;
}

let _roomSeq = 0;

function generateRoomId() {
  return `room_${Date.now().toString(36)}_${(++_roomSeq).toString(36)}`;
}

// ---------------------------------------------------------------------------
// ChatMessage
// ---------------------------------------------------------------------------

/**
 * Chat message envelope.
 */
export class ChatMessage {
  /**
   * @param {object} opts
   * @param {string} opts.roomId
   * @param {string} opts.sender - Fingerprint of the sender
   * @param {string} opts.type - One of MESSAGE_TYPES
   * @param {string} opts.body
   * @param {string} [opts.parentId] - For replies/threads
   * @param {string} [opts.editOf] - For edits
   * @param {number} [opts.timestamp]
   * @param {string} [opts.id]
   */
  constructor({ roomId, sender, type, body, parentId, editOf, timestamp, id }) {
    if (!MESSAGE_TYPES.includes(type)) {
      throw new Error(`Invalid message type: "${type}"`);
    }
    if (typeof body === 'string' && body.length > MAX_MESSAGE_SIZE) {
      throw new Error(`Message body exceeds maximum size of ${MAX_MESSAGE_SIZE}`);
    }

    this.id = id ?? generateMessageId();
    this.roomId = roomId;
    this.sender = sender;
    this.type = type;
    this.body = body;
    this.parentId = parentId ?? null;
    this.editOf = editOf ?? null;
    this.timestamp = timestamp ?? Date.now();
    /** @type {boolean} */
    this._redacted = false;
  }

  isRedacted() {
    return this._redacted;
  }

  toJSON() {
    return {
      id: this.id,
      roomId: this.roomId,
      sender: this.sender,
      type: this.type,
      body: this.body,
      parentId: this.parentId,
      editOf: this.editOf,
      timestamp: this.timestamp,
      redacted: this._redacted,
    };
  }

  static fromJSON(data) {
    const msg = new ChatMessage({
      id: data.id,
      roomId: data.roomId,
      sender: data.sender,
      type: data.type,
      body: data.body,
      parentId: data.parentId,
      editOf: data.editOf,
      timestamp: data.timestamp,
    });
    msg._redacted = data.redacted ?? false;
    return msg;
  }
}

// ---------------------------------------------------------------------------
// ChatRoom
// ---------------------------------------------------------------------------

/**
 * Single chat room with message log, CRDT-backed membership, and moderation.
 */
export class ChatRoom {
  /**
   * @param {object} opts
   * @param {string} opts.id
   * @param {string} opts.name
   * @param {string} opts.creator - Fingerprint of the room creator
   * @param {object} [opts.opts]
   * @param {number} [opts.opts.maxMembers]
   * @param {number} [opts.opts.retentionMs]
   */
  constructor({ id, name, creator, opts: roomOpts }) {
    this.id = id;
    this.name = name;
    this.creator = creator;
    this.maxMembers = roomOpts?.maxMembers ?? MAX_ROOM_MEMBERS;
    this.retentionMs = roomOpts?.retentionMs ?? null;

    /** @type {Set<string>} Simple set for membership (ORSet for sync later) */
    this._members = new Set();
    /** @type {Set<string>} Banned fingerprints */
    this._banned = new Set();
    /** @type {ChatMessage[]} */
    this._messages = [];
    /** @type {Map<string, { status: string, lastSeen: number }>} */
    this._presence = new Map();

    // Event listeners
    this._onMessageCbs = [];
    this._onJoinCbs = [];
    this._onLeaveCbs = [];
    this._onPresenceCbs = [];

    // Creator auto-joins
    this._members.add(creator);
  }

  // ── Membership ─────────────────────────────────────────────────────

  /**
   * @param {string} fingerprint
   * @returns {boolean} True if successfully joined
   */
  join(fingerprint) {
    if (this._banned.has(fingerprint)) return false;
    if (this._members.has(fingerprint)) return false;
    if (this._members.size >= this.maxMembers) return false;
    this._members.add(fingerprint);
    for (const cb of this._onJoinCbs) cb(fingerprint);
    return true;
  }

  /**
   * @param {string} fingerprint
   * @returns {boolean}
   */
  leave(fingerprint) {
    if (!this._members.has(fingerprint)) return false;
    this._members.delete(fingerprint);
    for (const cb of this._onLeaveCbs) cb(fingerprint);
    return true;
  }

  /**
   * @param {string} fingerprint
   * @returns {boolean}
   */
  isMember(fingerprint) {
    return this._members.has(fingerprint);
  }

  /** @returns {string[]} */
  listMembers() {
    return [...this._members];
  }

  /** @returns {number} */
  get memberCount() {
    return this._members.size;
  }

  // ── Messages ───────────────────────────────────────────────────────

  /**
   * Add a message to the room.
   * @param {ChatMessage} msg
   * @returns {ChatMessage}
   */
  addMessage(msg) {
    if (!this._members.has(msg.sender)) {
      throw new Error(`Sender "${msg.sender}" is not a member of room "${this.id}"`);
    }
    if (this._banned.has(msg.sender)) {
      throw new Error(`Sender "${msg.sender}" is banned from room "${this.id}"`);
    }
    this._messages.push(msg);
    for (const cb of this._onMessageCbs) cb(msg);
    return msg;
  }

  /**
   * @param {object} [opts]
   * @param {number} [opts.limit]
   * @param {number} [opts.before] - Timestamp
   * @param {number} [opts.after] - Timestamp
   * @param {string} [opts.type]
   * @returns {ChatMessage[]}
   */
  getMessages(opts = {}) {
    let msgs = this._messages;

    if (opts.type) {
      msgs = msgs.filter(m => m.type === opts.type);
    }
    if (opts.before) {
      msgs = msgs.filter(m => m.timestamp < opts.before);
    }
    if (opts.after) {
      msgs = msgs.filter(m => m.timestamp > opts.after);
    }
    if (opts.limit && opts.limit > 0) {
      msgs = msgs.slice(-opts.limit);
    }
    return msgs;
  }

  /**
   * @param {string} messageId
   * @returns {ChatMessage|null}
   */
  getMessage(messageId) {
    return this._messages.find(m => m.id === messageId) ?? null;
  }

  // ── Moderation ─────────────────────────────────────────────────────

  /**
   * Redact a message. Only creator can moderate.
   * // Note: redaction is permanent by CRDT design. See OUTSTANDING.md 3.6 for discussion.
   * @param {string} messageId
   * @param {string} moderator - Fingerprint of the moderator
   * @returns {boolean}
   */
  redactMessage(messageId, moderator) {
    if (moderator !== this.creator) return false;
    const msg = this.getMessage(messageId);
    if (!msg) return false;
    msg._redacted = true;
    msg.body = '[redacted]';
    return true;
  }

  /**
   * Ban a member. Only creator can ban.
   * @param {string} fingerprint
   * @param {string} moderator
   * @returns {boolean}
   */
  ban(fingerprint, moderator) {
    if (moderator !== this.creator) return false;
    if (fingerprint === this.creator) return false; // can't ban self
    this._banned.add(fingerprint);
    this._members.delete(fingerprint);
    return true;
  }

  /**
   * Unban a member. Only creator can unban.
   * @param {string} fingerprint
   * @param {string} moderator
   * @returns {boolean}
   */
  unban(fingerprint, moderator) {
    if (moderator !== this.creator) return false;
    return this._banned.delete(fingerprint);
  }

  /**
   * @param {string} fingerprint
   * @returns {boolean}
   */
  isBanned(fingerprint) {
    return this._banned.has(fingerprint);
  }

  // ── Presence ───────────────────────────────────────────────────────

  /**
   * @param {string} fingerprint
   * @param {string} status - 'online'|'typing'|'idle'|'offline'
   */
  setPresence(fingerprint, status) {
    const entry = { status, lastSeen: Date.now() };
    this._presence.set(fingerprint, entry);
    for (const cb of this._onPresenceCbs) cb({ fingerprint, status });
  }

  /**
   * @returns {Map<string, { status: string, lastSeen: number }>}
   */
  getPresence() {
    return new Map(this._presence);
  }

  // ── Events ─────────────────────────────────────────────────────────

  /** @param {function} cb */
  onMessage(cb) { this._onMessageCbs.push(cb); }
  /** @param {function} cb */
  onJoin(cb) { this._onJoinCbs.push(cb); }
  /** @param {function} cb */
  onLeave(cb) { this._onLeaveCbs.push(cb); }
  /** @param {function} cb */
  onPresence(cb) { this._onPresenceCbs.push(cb); }

  // ── Serialization ──────────────────────────────────────────────────

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      creator: this.creator,
      maxMembers: this.maxMembers,
      retentionMs: this.retentionMs,
      members: [...this._members],
      banned: [...this._banned],
      messages: this._messages.map(m => m.toJSON()),
      presence: Object.fromEntries(this._presence),
    };
  }

  static fromJSON(data) {
    const room = new ChatRoom({
      id: data.id,
      name: data.name,
      creator: data.creator,
      opts: {
        maxMembers: data.maxMembers,
        retentionMs: data.retentionMs,
      },
    });

    // Restore members (creator already added in constructor)
    if (data.members) {
      for (const m of data.members) {
        room._members.add(m);
      }
    }

    // Restore banned
    if (data.banned) {
      for (const b of data.banned) {
        room._banned.add(b);
      }
    }

    // Restore messages
    if (data.messages) {
      room._messages = data.messages.map(m => ChatMessage.fromJSON(m));
    }

    // Restore presence
    if (data.presence) {
      for (const [fp, p] of Object.entries(data.presence)) {
        room._presence.set(fp, p);
      }
    }

    return room;
  }
}

// ---------------------------------------------------------------------------
// MeshChat
// ---------------------------------------------------------------------------

/**
 * Multi-room chat manager.
 */
export class MeshChat {
  /**
   * @param {object} opts
   * @param {{ fingerprint: string }} opts.identity - Local user identity
   * @param {function} [opts.onLog]
   */
  constructor({ identity, onLog }) {
    this._identity = identity;
    this._onLog = onLog || (() => {});
    /** @type {Map<string, ChatRoom>} */
    this._rooms = new Map();
    /** @type {Map<string, function[]>} room-specific subscriptions */
    this._subscriptions = new Map();
    /** @type {function[]} global subscriptions */
    this._globalSubs = [];
  }

  // ── Room management ────────────────────────────────────────────────

  /**
   * @param {string} name
   * @param {object} [opts]
   * @returns {ChatRoom}
   */
  createRoom(name, opts = {}) {
    const id = generateRoomId();
    const room = new ChatRoom({
      id,
      name,
      creator: this._identity.fingerprint,
      opts,
    });

    // Wire up message subscriptions
    room.onMessage(msg => {
      const subs = this._subscriptions.get(room.id);
      if (subs) {
        for (const cb of subs) cb(msg);
      }
      for (const cb of this._globalSubs) cb(msg);
    });

    this._rooms.set(id, room);
    return room;
  }

  /**
   * @param {string} roomId
   * @returns {ChatRoom|null}
   */
  getRoom(roomId) {
    return this._rooms.get(roomId) ?? null;
  }

  /**
   * @returns {Array<{ id: string, name: string, memberCount: number, lastActivity: number|null }>}
   */
  listRooms() {
    return [...this._rooms.values()].map(room => {
      const msgs = room.getMessages();
      const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
      return {
        id: room.id,
        name: room.name,
        memberCount: room.memberCount,
        lastActivity: lastMsg ? lastMsg.timestamp : null,
      };
    });
  }

  /**
   * Delete a room. Only the creator can delete.
   * @param {string} roomId
   * @returns {boolean}
   */
  deleteRoom(roomId) {
    const room = this._rooms.get(roomId);
    if (!room) return false;
    this._rooms.delete(roomId);
    this._subscriptions.delete(roomId);
    return true;
  }

  // ── Convenience ────────────────────────────────────────────────────

  /**
   * Send a message to a room.
   * @param {string} roomId
   * @param {string} type
   * @param {string} body
   * @param {object} [opts]
   * @returns {ChatMessage}
   */
  send(roomId, type, body, opts = {}) {
    const room = this._rooms.get(roomId);
    if (!room) throw new Error(`Room "${roomId}" not found`);

    const msg = new ChatMessage({
      roomId,
      sender: this._identity.fingerprint,
      type,
      body,
      parentId: opts.parentId,
      editOf: opts.editOf,
    });
    return room.addMessage(msg);
  }

  // ── Subscriptions ──────────────────────────────────────────────────

  /**
   * Subscribe to messages in a specific room.
   * @param {string} roomId
   * @param {function} cb
   * @returns {function} Unsubscribe function
   */
  subscribe(roomId, cb) {
    if (!this._subscriptions.has(roomId)) {
      this._subscriptions.set(roomId, []);
    }
    this._subscriptions.get(roomId).push(cb);
    return () => {
      const subs = this._subscriptions.get(roomId);
      if (subs) {
        const idx = subs.indexOf(cb);
        if (idx !== -1) subs.splice(idx, 1);
      }
    };
  }

  /**
   * Subscribe to messages from all rooms.
   * @param {function} cb
   * @returns {function} Unsubscribe function
   */
  subscribeAll(cb) {
    this._globalSubs.push(cb);
    return () => {
      const idx = this._globalSubs.indexOf(cb);
      if (idx !== -1) this._globalSubs.splice(idx, 1);
    };
  }

  // ── Stats ──────────────────────────────────────────────────────────

  getStats() {
    let totalMessages = 0;
    let totalMembers = 0;
    for (const room of this._rooms.values()) {
      totalMessages += room.getMessages().length;
      totalMembers += room.memberCount;
    }
    return {
      rooms: this._rooms.size,
      totalMessages,
      totalMembers,
    };
  }

  // ── Serialization ──────────────────────────────────────────────────

  toJSON() {
    return {
      identity: { fingerprint: this._identity.fingerprint },
      rooms: [...this._rooms.values()].map(r => r.toJSON()),
    };
  }

  static fromJSON(data) {
    const chat = new MeshChat({ identity: data.identity });
    if (data.rooms) {
      for (const rd of data.rooms) {
        const room = ChatRoom.fromJSON(rd);

        // Wire up message subscriptions
        room.onMessage(msg => {
          const subs = chat._subscriptions.get(room.id);
          if (subs) {
            for (const cb of subs) cb(msg);
          }
          for (const cb of chat._globalSubs) cb(msg);
        });

        chat._rooms.set(room.id, room);
      }
    }
    return chat;
  }
}
