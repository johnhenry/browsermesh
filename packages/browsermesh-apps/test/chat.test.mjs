// Run with: node --import ./test/_setup-globals.mjs --test test/chat.test.mjs
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  MESSAGE_TYPES,
  MAX_MESSAGE_SIZE,
  MAX_ROOM_MEMBERS,
  ChatMessage,
  ChatRoom,
  MeshChat,
} from '../src/chat.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('Chat constants', () => {
  it('MESSAGE_TYPES is frozen', () => {
    assert.ok(Object.isFrozen(MESSAGE_TYPES));
  });

  it('MESSAGE_TYPES has expected entries', () => {
    assert.ok(MESSAGE_TYPES.includes('text'));
    assert.ok(MESSAGE_TYPES.includes('file'));
    assert.ok(MESSAGE_TYPES.includes('reply'));
    assert.ok(MESSAGE_TYPES.includes('reaction'));
    assert.ok(MESSAGE_TYPES.includes('edit'));
    assert.ok(MESSAGE_TYPES.includes('redaction'));
    assert.ok(MESSAGE_TYPES.includes('system'));
  });

  it('MAX_MESSAGE_SIZE is 32768', () => {
    assert.equal(MAX_MESSAGE_SIZE, 32768);
  });

  it('MAX_ROOM_MEMBERS is 256', () => {
    assert.equal(MAX_ROOM_MEMBERS, 256);
  });
});

// ---------------------------------------------------------------------------
// ChatMessage
// ---------------------------------------------------------------------------

describe('ChatMessage', () => {
  it('constructs with required fields', () => {
    const msg = new ChatMessage({
      roomId: 'room1',
      sender: 'fp1',
      type: 'text',
      body: 'hello',
    });
    assert.equal(msg.roomId, 'room1');
    assert.equal(msg.sender, 'fp1');
    assert.equal(msg.type, 'text');
    assert.equal(msg.body, 'hello');
    assert.ok(typeof msg.id === 'string');
    assert.ok(typeof msg.timestamp === 'number');
  });

  it('auto-generates unique IDs', () => {
    const a = new ChatMessage({ roomId: 'r', sender: 's', type: 'text', body: 'a' });
    const b = new ChatMessage({ roomId: 'r', sender: 's', type: 'text', body: 'b' });
    assert.notEqual(a.id, b.id);
  });

  it('accepts optional parentId and editOf', () => {
    const msg = new ChatMessage({
      roomId: 'r',
      sender: 's',
      type: 'reply',
      body: 'reply text',
      parentId: 'msg_parent',
      editOf: 'msg_orig',
    });
    assert.equal(msg.parentId, 'msg_parent');
    assert.equal(msg.editOf, 'msg_orig');
  });

  it('rejects invalid message type', () => {
    assert.throws(() => new ChatMessage({
      roomId: 'r',
      sender: 's',
      type: 'invalid_type',
      body: 'x',
    }), Error);
  });

  it('rejects oversized body', () => {
    const bigBody = 'x'.repeat(MAX_MESSAGE_SIZE + 1);
    assert.throws(() => new ChatMessage({
      roomId: 'r',
      sender: 's',
      type: 'text',
      body: bigBody,
    }), Error);
  });

  it('isRedacted returns false by default', () => {
    const msg = new ChatMessage({ roomId: 'r', sender: 's', type: 'text', body: 'hi' });
    assert.ok(!msg.isRedacted());
  });

  it('round-trips via JSON', () => {
    const msg = new ChatMessage({
      roomId: 'r',
      sender: 's',
      type: 'text',
      body: 'hello',
      parentId: 'p1',
    });
    const msg2 = ChatMessage.fromJSON(msg.toJSON());
    assert.equal(msg2.id, msg.id);
    assert.equal(msg2.body, 'hello');
    assert.equal(msg2.parentId, 'p1');
  });
});

// ---------------------------------------------------------------------------
// ChatRoom — membership
// ---------------------------------------------------------------------------

describe('ChatRoom membership', () => {
  let room;
  beforeEach(() => {
    room = new ChatRoom({ id: 'room1', name: 'General', creator: 'fp_creator' });
  });

  it('creator is auto-joined', () => {
    assert.ok(room.isMember('fp_creator'));
    assert.equal(room.memberCount, 1);
  });

  it('join adds a member', () => {
    assert.ok(room.join('fp1'));
    assert.ok(room.isMember('fp1'));
    assert.equal(room.memberCount, 2);
  });

  it('join returns false for already-member', () => {
    room.join('fp1');
    assert.ok(!room.join('fp1'));
  });

  it('leave removes a member', () => {
    room.join('fp1');
    assert.ok(room.leave('fp1'));
    assert.ok(!room.isMember('fp1'));
  });

  it('leave returns false for non-member', () => {
    assert.ok(!room.leave('fp_nobody'));
  });

  it('listMembers returns all members', () => {
    room.join('fp1');
    room.join('fp2');
    const members = room.listMembers();
    assert.equal(members.length, 3); // creator + 2
    assert.ok(members.includes('fp_creator'));
    assert.ok(members.includes('fp1'));
    assert.ok(members.includes('fp2'));
  });

  it('join rejects banned member', () => {
    room.join('fp1');
    room.ban('fp1', 'fp_creator');
    assert.ok(!room.join('fp1'));
  });
});

// ---------------------------------------------------------------------------
// ChatRoom — messages
// ---------------------------------------------------------------------------

describe('ChatRoom messages', () => {
  let room;
  beforeEach(() => {
    room = new ChatRoom({ id: 'room1', name: 'General', creator: 'fp_creator' });
    room.join('fp1');
  });

  it('addMessage adds a message', () => {
    const msg = new ChatMessage({ roomId: 'room1', sender: 'fp1', type: 'text', body: 'hi' });
    const added = room.addMessage(msg);
    assert.equal(added.body, 'hi');
  });

  it('addMessage rejects non-member sender', () => {
    const msg = new ChatMessage({ roomId: 'room1', sender: 'stranger', type: 'text', body: 'hi' });
    assert.throws(() => room.addMessage(msg), Error);
  });

  it('addMessage rejects banned sender', () => {
    room.ban('fp1', 'fp_creator');
    const msg = new ChatMessage({ roomId: 'room1', sender: 'fp1', type: 'text', body: 'hi' });
    assert.throws(() => room.addMessage(msg), Error);
  });

  it('getMessages returns messages', () => {
    room.addMessage(new ChatMessage({ roomId: 'room1', sender: 'fp1', type: 'text', body: 'a' }));
    room.addMessage(new ChatMessage({ roomId: 'room1', sender: 'fp1', type: 'text', body: 'b' }));
    const msgs = room.getMessages();
    assert.equal(msgs.length, 2);
  });

  it('getMessages with limit', () => {
    room.addMessage(new ChatMessage({ roomId: 'room1', sender: 'fp1', type: 'text', body: 'a' }));
    room.addMessage(new ChatMessage({ roomId: 'room1', sender: 'fp1', type: 'text', body: 'b' }));
    room.addMessage(new ChatMessage({ roomId: 'room1', sender: 'fp1', type: 'text', body: 'c' }));
    const msgs = room.getMessages({ limit: 2 });
    assert.equal(msgs.length, 2);
  });

  it('getMessages with type filter', () => {
    room.addMessage(new ChatMessage({ roomId: 'room1', sender: 'fp1', type: 'text', body: 'a' }));
    room.addMessage(new ChatMessage({ roomId: 'room1', sender: 'fp1', type: 'system', body: 'sys' }));
    const msgs = room.getMessages({ type: 'system' });
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].body, 'sys');
  });

  it('getMessage by ID', () => {
    const msg = room.addMessage(
      new ChatMessage({ roomId: 'room1', sender: 'fp1', type: 'text', body: 'find me' })
    );
    const found = room.getMessage(msg.id);
    assert.ok(found);
    assert.equal(found.body, 'find me');
  });

  it('getMessage returns null for unknown', () => {
    assert.equal(room.getMessage('nonexistent'), null);
  });
});

// ---------------------------------------------------------------------------
// ChatRoom — moderation
// ---------------------------------------------------------------------------

describe('ChatRoom moderation', () => {
  let room;
  beforeEach(() => {
    room = new ChatRoom({ id: 'room1', name: 'General', creator: 'fp_creator' });
    room.join('fp1');
    room.join('fp2');
  });

  it('redactMessage by creator', () => {
    const msg = room.addMessage(
      new ChatMessage({ roomId: 'room1', sender: 'fp1', type: 'text', body: 'bad content' })
    );
    assert.ok(room.redactMessage(msg.id, 'fp_creator'));
    assert.ok(msg.isRedacted());
  });

  it('redactMessage rejects non-creator', () => {
    const msg = room.addMessage(
      new ChatMessage({ roomId: 'room1', sender: 'fp1', type: 'text', body: 'content' })
    );
    assert.ok(!room.redactMessage(msg.id, 'fp2'));
  });

  it('ban prevents further messages', () => {
    assert.ok(room.ban('fp1', 'fp_creator'));
    assert.ok(room.isBanned('fp1'));
    assert.ok(!room.isMember('fp1'));
  });

  it('ban rejects non-creator moderator', () => {
    assert.ok(!room.ban('fp1', 'fp2'));
  });

  it('unban restores ability to rejoin', () => {
    room.ban('fp1', 'fp_creator');
    assert.ok(room.unban('fp1', 'fp_creator'));
    assert.ok(!room.isBanned('fp1'));
    assert.ok(room.join('fp1'));
  });
});

// ---------------------------------------------------------------------------
// ChatRoom — presence
// ---------------------------------------------------------------------------

describe('ChatRoom presence', () => {
  let room;
  beforeEach(() => {
    room = new ChatRoom({ id: 'room1', name: 'General', creator: 'fp_creator' });
    room.join('fp1');
  });

  it('setPresence and getPresence', () => {
    room.setPresence('fp1', 'typing');
    const presence = room.getPresence();
    assert.ok(presence.has('fp1'));
    assert.equal(presence.get('fp1').status, 'typing');
  });

  it('updates presence timestamp', () => {
    room.setPresence('fp1', 'online');
    const p = room.getPresence().get('fp1');
    assert.ok(typeof p.lastSeen === 'number');
  });
});

// ---------------------------------------------------------------------------
// ChatRoom — events
// ---------------------------------------------------------------------------

describe('ChatRoom events', () => {
  let room;
  beforeEach(() => {
    room = new ChatRoom({ id: 'room1', name: 'General', creator: 'fp_creator' });
  });

  it('onMessage fires on addMessage', () => {
    let received = null;
    room.onMessage(msg => { received = msg; });
    room.join('fp1');
    const msg = room.addMessage(
      new ChatMessage({ roomId: 'room1', sender: 'fp1', type: 'text', body: 'event test' })
    );
    assert.ok(received);
    assert.equal(received.body, 'event test');
  });

  it('onJoin fires on join', () => {
    let joined = null;
    room.onJoin(fp => { joined = fp; });
    room.join('fp1');
    assert.equal(joined, 'fp1');
  });

  it('onLeave fires on leave', () => {
    let left = null;
    room.onLeave(fp => { left = fp; });
    room.join('fp1');
    room.leave('fp1');
    assert.equal(left, 'fp1');
  });

  it('onPresence fires on setPresence', () => {
    let data = null;
    room.onPresence(d => { data = d; });
    room.join('fp1');
    room.setPresence('fp1', 'typing');
    assert.ok(data);
    assert.equal(data.fingerprint, 'fp1');
    assert.equal(data.status, 'typing');
  });
});

// ---------------------------------------------------------------------------
// ChatRoom — serialization
// ---------------------------------------------------------------------------

describe('ChatRoom serialization', () => {
  it('round-trips via JSON', () => {
    const room = new ChatRoom({ id: 'room1', name: 'General', creator: 'fp_creator' });
    room.join('fp1');
    room.addMessage(
      new ChatMessage({ roomId: 'room1', sender: 'fp1', type: 'text', body: 'hello' })
    );
    room.setPresence('fp1', 'online');

    const room2 = ChatRoom.fromJSON(room.toJSON());
    assert.equal(room2.id, 'room1');
    assert.equal(room2.name, 'General');
    assert.ok(room2.isMember('fp_creator'));
    assert.ok(room2.isMember('fp1'));
    assert.equal(room2.getMessages().length, 1);
    assert.equal(room2.getMessages()[0].body, 'hello');
  });
});

// ---------------------------------------------------------------------------
// MeshChat — room management
// ---------------------------------------------------------------------------

describe('MeshChat room management', () => {
  let chat;
  beforeEach(() => {
    chat = new MeshChat({ identity: { fingerprint: 'fp_me' } });
  });

  it('createRoom creates a room', () => {
    const room = chat.createRoom('General');
    assert.ok(room);
    assert.equal(room.name, 'General');
    assert.ok(room.isMember('fp_me'));
  });

  it('getRoom retrieves a room', () => {
    const room = chat.createRoom('Test');
    const found = chat.getRoom(room.id);
    assert.ok(found);
    assert.equal(found.name, 'Test');
  });

  it('getRoom returns null for unknown', () => {
    assert.equal(chat.getRoom('nonexistent'), null);
  });

  it('listRooms returns room summaries', () => {
    chat.createRoom('Room1');
    chat.createRoom('Room2');
    const list = chat.listRooms();
    assert.equal(list.length, 2);
    assert.ok(list[0].id);
    assert.ok(list[0].name);
    assert.ok(typeof list[0].memberCount === 'number');
  });

  it('deleteRoom removes a room', () => {
    const room = chat.createRoom('Temp');
    assert.ok(chat.deleteRoom(room.id));
    assert.equal(chat.getRoom(room.id), null);
  });

  it('deleteRoom returns false for unknown room', () => {
    assert.ok(!chat.deleteRoom('nonexistent'));
  });
});

// ---------------------------------------------------------------------------
// MeshChat — send
// ---------------------------------------------------------------------------

describe('MeshChat send', () => {
  let chat;
  beforeEach(() => {
    chat = new MeshChat({ identity: { fingerprint: 'fp_me' } });
  });

  it('send creates a message in the room', () => {
    const room = chat.createRoom('General');
    const msg = chat.send(room.id, 'text', 'hello');
    assert.ok(msg);
    assert.equal(msg.body, 'hello');
    assert.equal(msg.sender, 'fp_me');
  });

  it('send throws for unknown room', () => {
    assert.throws(() => chat.send('bad_room', 'text', 'hello'), Error);
  });
});

// ---------------------------------------------------------------------------
// MeshChat — subscriptions
// ---------------------------------------------------------------------------

describe('MeshChat subscriptions', () => {
  let chat;
  beforeEach(() => {
    chat = new MeshChat({ identity: { fingerprint: 'fp_me' } });
  });

  it('subscribe receives messages for a room', () => {
    const room = chat.createRoom('General');
    let received = null;
    chat.subscribe(room.id, msg => { received = msg; });
    chat.send(room.id, 'text', 'sub test');
    assert.ok(received);
    assert.equal(received.body, 'sub test');
  });

  it('subscribe returns unsubscribe function', () => {
    const room = chat.createRoom('General');
    let count = 0;
    const unsub = chat.subscribe(room.id, () => { count++; });
    chat.send(room.id, 'text', 'a');
    unsub();
    chat.send(room.id, 'text', 'b');
    assert.equal(count, 1);
  });

  it('subscribeAll receives messages from all rooms', () => {
    const r1 = chat.createRoom('Room1');
    const r2 = chat.createRoom('Room2');
    const messages = [];
    chat.subscribeAll(msg => { messages.push(msg); });
    chat.send(r1.id, 'text', 'from r1');
    chat.send(r2.id, 'text', 'from r2');
    assert.equal(messages.length, 2);
  });
});

// ---------------------------------------------------------------------------
// MeshChat — stats
// ---------------------------------------------------------------------------

describe('MeshChat stats', () => {
  it('getStats returns aggregate stats', () => {
    const chat = new MeshChat({ identity: { fingerprint: 'fp_me' } });
    const r1 = chat.createRoom('Room1');
    const r2 = chat.createRoom('Room2');
    chat.send(r1.id, 'text', 'a');
    chat.send(r1.id, 'text', 'b');
    chat.send(r2.id, 'text', 'c');

    const stats = chat.getStats();
    assert.equal(stats.rooms, 2);
    assert.equal(stats.totalMessages, 3);
    assert.ok(stats.totalMembers >= 1); // at least the creator in each
  });
});

// ---------------------------------------------------------------------------
// MeshChat — serialization
// ---------------------------------------------------------------------------

describe('MeshChat serialization', () => {
  it('round-trips via JSON', () => {
    const chat = new MeshChat({ identity: { fingerprint: 'fp_me' } });
    const room = chat.createRoom('General');
    chat.send(room.id, 'text', 'persist me');

    const chat2 = MeshChat.fromJSON(chat.toJSON());
    const rooms = chat2.listRooms();
    assert.equal(rooms.length, 1);
    assert.equal(rooms[0].name, 'General');

    const r = chat2.getRoom(rooms[0].id);
    assert.ok(r);
    assert.equal(r.getMessages().length, 1);
    assert.equal(r.getMessages()[0].body, 'persist me');
  });
});
