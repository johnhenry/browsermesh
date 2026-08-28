import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  messageTypeRegistry,
  encodeMeshMessage,
  decodeMeshMessage,
} from '../src/wire.mjs';
import { MESH_TYPE } from '../src/constants.mjs';
import { MeshProtocolError } from '../src/errors.mjs';

describe('messageTypeRegistry', () => {
  it('is a Map', () => {
    assert.ok(messageTypeRegistry instanceof Map);
  });

  it('maps all MESH_TYPE values to names', () => {
    for (const [name, code] of Object.entries(MESH_TYPE)) {
      assert.equal(messageTypeRegistry.get(code), name);
    }
  });

  it('has the correct number of entries', () => {
    assert.equal(messageTypeRegistry.size, Object.keys(MESH_TYPE).length);
  });
});

describe('encodeMeshMessage', () => {
  it('encodes a unicast message', () => {
    const message = {
      type: MESH_TYPE.UNICAST,
      from: 'pod-a',
      to: 'pod-b',
      payload: { data: 'hello' },
      ttl: 30,
    };
    const bytes = encodeMeshMessage(message);
    assert.ok(bytes instanceof Uint8Array);
    assert.equal(bytes[0], MESH_TYPE.UNICAST);
    assert.ok(bytes.length > 5);
  });

  it('encodes a broadcast message (no to field)', () => {
    const message = {
      type: MESH_TYPE.BROADCAST,
      from: 'pod-a',
      payload: { data: 'broadcast' },
    };
    const bytes = encodeMeshMessage(message);
    assert.equal(bytes[0], MESH_TYPE.BROADCAST);
  });

  it('encodes payload length as big-endian uint32', () => {
    const message = {
      type: MESH_TYPE.PING,
      from: 'pod-a',
      payload: null,
    };
    const bytes = encodeMeshMessage(message);
    const view = new DataView(bytes.buffer);
    const payloadLen = view.getUint32(1, false);
    assert.equal(payloadLen, bytes.length - 5);
  });

  it('throws MeshProtocolError for unknown message type', () => {
    assert.throws(
      () => encodeMeshMessage({ type: 0x00, from: 'a', payload: null }),
      (err) => err instanceof MeshProtocolError && err.message.includes('Unknown message type')
    );
  });

  it('throws MeshProtocolError for unregistered type code', () => {
    assert.throws(
      () => encodeMeshMessage({ type: 0xff, from: 'a', payload: null }),
      MeshProtocolError
    );
  });
});

describe('decodeMeshMessage', () => {
  it('decodes an encoded message', () => {
    const original = {
      type: MESH_TYPE.UNICAST,
      from: 'pod-a',
      to: 'pod-b',
      payload: { data: 'hello' },
      ttl: 30,
    };
    const bytes = encodeMeshMessage(original);
    const decoded = decodeMeshMessage(bytes);
    assert.equal(decoded.type, MESH_TYPE.UNICAST);
    assert.equal(decoded.from, 'pod-a');
    assert.equal(decoded.to, 'pod-b');
    assert.deepEqual(decoded.payload, { data: 'hello' });
    assert.equal(decoded.ttl, 30);
  });

  it('throws for non-Uint8Array input', () => {
    assert.throws(
      () => decodeMeshMessage('not bytes'),
      MeshProtocolError
    );
  });

  it('throws for bytes shorter than 5', () => {
    assert.throws(
      () => decodeMeshMessage(new Uint8Array([0xa0, 0, 0])),
      MeshProtocolError
    );
  });

  it('throws for unknown message type', () => {
    const bytes = new Uint8Array(5);
    bytes[0] = 0x00; // unknown type
    assert.throws(
      () => decodeMeshMessage(bytes),
      (err) => err instanceof MeshProtocolError && err.message.includes('Unknown message type')
    );
  });

  it('throws for truncated message', () => {
    const original = {
      type: MESH_TYPE.PING,
      from: 'pod-a',
      payload: 'test data',
    };
    const bytes = encodeMeshMessage(original);
    // Truncate the message
    const truncated = bytes.subarray(0, bytes.length - 5);
    assert.throws(
      () => decodeMeshMessage(truncated),
      (err) => err instanceof MeshProtocolError && err.message.includes('Truncated')
    );
  });
});

describe('encode/decode round-trip', () => {
  it('round-trips unicast with complex payload', () => {
    const message = {
      type: MESH_TYPE.UNICAST,
      from: 'pod-alpha',
      to: 'pod-beta',
      payload: { nested: { array: [1, 2, 3], flag: true } },
      ttl: 60,
    };
    const decoded = decodeMeshMessage(encodeMeshMessage(message));
    assert.equal(decoded.type, message.type);
    assert.equal(decoded.from, message.from);
    assert.equal(decoded.to, message.to);
    assert.deepEqual(decoded.payload, message.payload);
    assert.equal(decoded.ttl, message.ttl);
  });

  it('round-trips broadcast with null payload', () => {
    const message = {
      type: MESH_TYPE.BROADCAST,
      from: 'pod-x',
      payload: null,
    };
    const decoded = decodeMeshMessage(encodeMeshMessage(message));
    assert.equal(decoded.type, MESH_TYPE.BROADCAST);
    assert.equal(decoded.from, 'pod-x');
    assert.equal(decoded.to, undefined);
    assert.equal(decoded.payload, null);
    assert.equal(decoded.ttl, undefined);
  });

  it('round-trips all MESH_TYPE values', () => {
    for (const [name, code] of Object.entries(MESH_TYPE)) {
      const message = {
        type: code,
        from: `sender-${name}`,
        to: `receiver-${name}`,
        payload: { type: name },
        ttl: 10,
      };
      const decoded = decodeMeshMessage(encodeMeshMessage(message));
      assert.equal(decoded.type, code, `Failed for ${name}`);
      assert.equal(decoded.from, `sender-${name}`);
    }
  });

  it('round-trips ping/pong', () => {
    const ping = { type: MESH_TYPE.PING, from: 'a', payload: null };
    const pong = { type: MESH_TYPE.PONG, from: 'b', payload: null };
    const decodedPing = decodeMeshMessage(encodeMeshMessage(ping));
    const decodedPong = decodeMeshMessage(encodeMeshMessage(pong));
    assert.equal(decodedPing.type, MESH_TYPE.PING);
    assert.equal(decodedPong.type, MESH_TYPE.PONG);
  });

  it('round-trips string payload', () => {
    const message = {
      type: MESH_TYPE.CRDT_SYNC,
      from: 'pod-1',
      payload: 'raw string payload',
      ttl: 5,
    };
    const decoded = decodeMeshMessage(encodeMeshMessage(message));
    assert.equal(decoded.payload, 'raw string payload');
  });
});
