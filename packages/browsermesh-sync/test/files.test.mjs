// Run with: node --import ./test/_setup-globals.mjs --test test/files.test.mjs
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  TRANSFER_STATES,
  TRANSFER_DEFAULTS,
  FileDescriptor,
  TransferOffer,
  ChunkStore,
  TransferState,
  MeshFileTransfer,
} from '../src/files.mjs';
import { MESH_TYPE } from '@johnhenry/browsermesh-primitives';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('TRANSFER_STATES', () => {
  it('contains all 6 states', () => {
    assert.deepEqual(TRANSFER_STATES, ['offered', 'accepted', 'transferring', 'completed', 'failed', 'cancelled']);
  });

  it('is frozen', () => {
    assert.ok(Object.isFrozen(TRANSFER_STATES));
  });
});

describe('TRANSFER_DEFAULTS', () => {
  it('has expected defaults', () => {
    assert.equal(TRANSFER_DEFAULTS.chunkSize, 256 * 1024);
    assert.equal(TRANSFER_DEFAULTS.maxConcurrentChunks, 16);
    assert.equal(TRANSFER_DEFAULTS.offerExpiry, 5 * 60 * 1000);
    assert.equal(TRANSFER_DEFAULTS.resumeTimeout, 30 * 60 * 1000);
  });

  it('is frozen', () => {
    assert.ok(Object.isFrozen(TRANSFER_DEFAULTS));
  });
});

// ---------------------------------------------------------------------------
// FileDescriptor
// ---------------------------------------------------------------------------

describe('FileDescriptor', () => {
  it('constructs with name and size', () => {
    const fd = new FileDescriptor({ name: 'photo.jpg', size: 1024 });
    assert.equal(fd.name, 'photo.jpg');
    assert.equal(fd.size, 1024);
    assert.equal(fd.mimeType, null);
    assert.equal(fd.cid, null);
  });

  it('stores optional mimeType and cid', () => {
    const fd = new FileDescriptor({ name: 'doc.pdf', size: 2048, mimeType: 'application/pdf', cid: 'abc123' });
    assert.equal(fd.mimeType, 'application/pdf');
    assert.equal(fd.cid, 'abc123');
  });

  it('throws without name', () => {
    assert.throws(() => new FileDescriptor({ size: 10 }), /requires a name/);
  });

  it('throws without valid size', () => {
    assert.throws(() => new FileDescriptor({ name: 'x' }), /requires a non-negative size/);
    assert.throws(() => new FileDescriptor({ name: 'x', size: -1 }), /requires a non-negative size/);
  });

  it('accepts size of 0', () => {
    const fd = new FileDescriptor({ name: 'empty.txt', size: 0 });
    assert.equal(fd.size, 0);
  });

  it('round-trips via JSON', () => {
    const fd = new FileDescriptor({ name: 'a.bin', size: 100, mimeType: 'application/octet-stream', cid: 'xyz' });
    const fd2 = FileDescriptor.fromJSON(fd.toJSON());
    assert.equal(fd2.name, 'a.bin');
    assert.equal(fd2.size, 100);
    assert.equal(fd2.mimeType, 'application/octet-stream');
    assert.equal(fd2.cid, 'xyz');
  });
});

// ---------------------------------------------------------------------------
// TransferOffer
// ---------------------------------------------------------------------------

describe('TransferOffer', () => {
  it('constructs with sender, recipient, and files', () => {
    const offer = new TransferOffer({
      sender: 'alice',
      recipient: 'bob',
      files: [{ name: 'a.txt', size: 100 }],
    });
    assert.equal(offer.sender, 'alice');
    assert.equal(offer.recipient, 'bob');
    assert.equal(offer.files.length, 1);
    assert.ok(offer.files[0] instanceof FileDescriptor);
    assert.equal(offer.totalSize, 100);
    assert.ok(offer.transferId.startsWith('xfer_'));
  });

  it('auto-calculates totalSize from files', () => {
    const offer = new TransferOffer({
      sender: 'a',
      recipient: 'b',
      files: [{ name: 'x', size: 50 }, { name: 'y', size: 75 }],
    });
    assert.equal(offer.totalSize, 125);
  });

  it('accepts explicit totalSize', () => {
    const offer = new TransferOffer({
      sender: 'a',
      recipient: 'b',
      files: [{ name: 'x', size: 50 }],
      totalSize: 999,
    });
    assert.equal(offer.totalSize, 999);
  });

  it('sets default expiry', () => {
    const before = Date.now();
    const offer = new TransferOffer({ sender: 'a', recipient: 'b', files: [] });
    assert.ok(offer.expires >= before + TRANSFER_DEFAULTS.offerExpiry - 100);
  });

  it('isExpired returns false when fresh', () => {
    const offer = new TransferOffer({ sender: 'a', recipient: 'b', files: [] });
    assert.equal(offer.isExpired(), false);
  });

  it('isExpired returns true when past expiry', () => {
    const offer = new TransferOffer({
      sender: 'a',
      recipient: 'b',
      files: [],
      expires: Date.now() - 1000,
    });
    assert.equal(offer.isExpired(), true);
  });

  it('round-trips via JSON', () => {
    const offer = new TransferOffer({
      sender: 'alice',
      recipient: 'bob',
      files: [{ name: 'f.txt', size: 42, mimeType: 'text/plain' }],
    });
    const offer2 = TransferOffer.fromJSON(offer.toJSON());
    assert.equal(offer2.transferId, offer.transferId);
    assert.equal(offer2.sender, 'alice');
    assert.equal(offer2.recipient, 'bob');
    assert.equal(offer2.files.length, 1);
    assert.equal(offer2.files[0].name, 'f.txt');
    assert.equal(offer2.totalSize, 42);
  });
});

// ---------------------------------------------------------------------------
// ChunkStore
// ---------------------------------------------------------------------------

describe('ChunkStore', () => {
  let store;

  beforeEach(() => {
    store = new ChunkStore();
  });

  it('starts empty', () => {
    assert.equal(store.size, 0);
  });

  it('saves and retrieves chunks', () => {
    const data = new Uint8Array([1, 2, 3]);
    store.save('abc', data);
    assert.deepEqual(store.get('abc'), data);
    assert.equal(store.size, 1);
  });

  it('has() returns true for existing chunks', () => {
    store.save('abc', new Uint8Array([1]));
    assert.ok(store.has('abc'));
    assert.ok(!store.has('def'));
  });

  it('removes chunks', () => {
    store.save('abc', new Uint8Array([1]));
    assert.ok(store.remove('abc'));
    assert.ok(!store.has('abc'));
    assert.equal(store.size, 0);
  });

  it('remove returns false for missing chunks', () => {
    assert.ok(!store.remove('nope'));
  });

  it('clears all chunks', () => {
    store.save('a', new Uint8Array([1]));
    store.save('b', new Uint8Array([2]));
    store.clear();
    assert.equal(store.size, 0);
  });

  it('computeCid returns 64-char hex string', async () => {
    const cid = await ChunkStore.computeCid(new Uint8Array([1, 2, 3]));
    assert.equal(typeof cid, 'string');
    assert.equal(cid.length, 64);
    assert.match(cid, /^[0-9a-f]{64}$/);
  });

  it('computeCid is deterministic', async () => {
    const data = new Uint8Array([10, 20, 30]);
    const cid1 = await ChunkStore.computeCid(data);
    const cid2 = await ChunkStore.computeCid(data);
    assert.equal(cid1, cid2);
  });

  it('computeCid differs for different data', async () => {
    const cid1 = await ChunkStore.computeCid(new Uint8Array([1]));
    const cid2 = await ChunkStore.computeCid(new Uint8Array([2]));
    assert.notEqual(cid1, cid2);
  });

  it('verify returns true for matching data', async () => {
    const data = new Uint8Array([42, 43, 44]);
    const cid = await ChunkStore.computeCid(data);
    assert.ok(await store.verify(cid, data));
  });

  it('verify returns false for mismatched data', async () => {
    const data = new Uint8Array([42]);
    const cid = await ChunkStore.computeCid(data);
    assert.ok(!(await store.verify(cid, new Uint8Array([99]))));
  });
});

// ---------------------------------------------------------------------------
// TransferState
// ---------------------------------------------------------------------------

describe('TransferState', () => {
  it('starts with offered status', () => {
    const ts = new TransferState({ transferId: 'x', totalSize: 1000 });
    assert.equal(ts.status, 'offered');
    assert.equal(ts.bytesTransferred, 0);
    assert.equal(ts.percentComplete, 0);
  });

  it('rejects invalid status', () => {
    const ts = new TransferState({ transferId: 'x', totalSize: 100 });
    assert.throws(() => { ts.status = 'invalid'; }, /Invalid transfer status/);
  });

  it('tracks bytesTransferred and percentComplete', () => {
    const ts = new TransferState({ transferId: 'x', totalSize: 200 });
    ts.addChunk(0, 'c1', 50);
    assert.equal(ts.bytesTransferred, 50);
    assert.equal(ts.percentComplete, 25);
  });

  it('auto-transitions to transferring on addChunk', () => {
    const ts = new TransferState({ transferId: 'x', totalSize: 100 });
    ts.addChunk(0, 'c1', 10);
    assert.equal(ts.status, 'transferring');
  });

  it('deduplicates chunks by CID', () => {
    const ts = new TransferState({ transferId: 'x', totalSize: 100 });
    ts.addChunk(0, 'c1', 50);
    ts.addChunk(0, 'c1', 50); // duplicate
    assert.equal(ts.bytesTransferred, 50);
  });

  it('isComplete when all bytes received', () => {
    const ts = new TransferState({ transferId: 'x', totalSize: 100 });
    ts.addChunk(0, 'c1', 60);
    assert.ok(!ts.isComplete());
    ts.addChunk(0, 'c2', 40);
    assert.ok(ts.isComplete());
  });

  it('handles zero-size transfer', () => {
    const ts = new TransferState({ transferId: 'x', totalSize: 0 });
    assert.equal(ts.percentComplete, 100);
    assert.ok(ts.isComplete());
  });

  it('getReceivedChunks returns CIDs for a file', () => {
    const ts = new TransferState({ transferId: 'x', totalSize: 100 });
    ts.addChunk(0, 'a', 50);
    ts.addChunk(1, 'b', 50);
    const file0Chunks = ts.getReceivedChunks(0);
    assert.ok(file0Chunks.has('a'));
    assert.ok(!file0Chunks.has('b'));
  });

  it('getReceivedChunks returns empty set for unknown file', () => {
    const ts = new TransferState({ transferId: 'x', totalSize: 100 });
    assert.equal(ts.getReceivedChunks(99).size, 0);
  });

  it('transferRate is 0 before transferring', () => {
    const ts = new TransferState({ transferId: 'x', totalSize: 100 });
    assert.equal(ts.transferRate, 0);
  });

  it('toJSON includes all fields', () => {
    const ts = new TransferState({ transferId: 'x', totalSize: 200 });
    ts.addChunk(0, 'c1', 100);
    const json = ts.toJSON();
    assert.equal(json.transferId, 'x');
    assert.equal(json.status, 'transferring');
    assert.equal(json.totalSize, 200);
    assert.equal(json.bytesTransferred, 100);
    assert.equal(json.percentComplete, 50);
    assert.ok(json.chunks.length === 1);
    assert.ok(json.fileChunks['0']);
  });
});

// ---------------------------------------------------------------------------
// MeshFileTransfer — construction
// ---------------------------------------------------------------------------

describe('MeshFileTransfer', () => {
  let ft;

  beforeEach(() => {
    ft = new MeshFileTransfer();
  });

  it('constructs with default store', () => {
    assert.ok(ft.store instanceof ChunkStore);
  });

  it('accepts custom store', () => {
    const store = new ChunkStore();
    const ft2 = new MeshFileTransfer({ store });
    assert.equal(ft2.store, store);
  });
});

// ---------------------------------------------------------------------------
// MeshFileTransfer — createOffer
// ---------------------------------------------------------------------------

describe('MeshFileTransfer createOffer', () => {
  it('creates an offer and emits FILE_OFFER', () => {
    const sent = [];
    const ft = new MeshFileTransfer();
    ft.onSend(msg => sent.push(msg));

    const offer = ft.createOffer('bob', [{ name: 'a.txt', size: 100 }], { sender: 'alice' });
    assert.ok(offer instanceof TransferOffer);
    assert.equal(offer.sender, 'alice');
    assert.equal(offer.recipient, 'bob');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].t, MESH_TYPE.FILE_OFFER);
  });

  it('creates a TransferState in offered status', () => {
    const ft = new MeshFileTransfer();
    const offer = ft.createOffer('bob', [{ name: 'x', size: 50 }]);
    const state = ft.getTransfer(offer.transferId);
    assert.ok(state);
    assert.equal(state.status, 'offered');
    assert.equal(state.totalSize, 50);
  });
});

// ---------------------------------------------------------------------------
// MeshFileTransfer — acceptOffer
// ---------------------------------------------------------------------------

describe('MeshFileTransfer acceptOffer', () => {
  it('accepts offer and emits FILE_ACCEPT', () => {
    const sent = [];
    const ft = new MeshFileTransfer();
    ft.onSend(msg => sent.push(msg));

    const offer = new TransferOffer({
      sender: 'alice',
      recipient: 'bob',
      files: [{ name: 'a.txt', size: 100 }],
    });
    const state = ft.acceptOffer(offer);
    assert.equal(state.status, 'accepted');
    const acceptMsg = sent.find(m => m.t === MESH_TYPE.FILE_ACCEPT);
    assert.ok(acceptMsg);
  });

  it('accepts plain object offer', () => {
    const ft = new MeshFileTransfer();
    const offer = new TransferOffer({ sender: 'a', recipient: 'b', files: [{ name: 'x', size: 10 }] });
    const state = ft.acceptOffer(offer.toJSON());
    assert.equal(state.status, 'accepted');
  });

  it('throws on expired offer', () => {
    const ft = new MeshFileTransfer();
    const offer = new TransferOffer({
      sender: 'a', recipient: 'b', files: [{ name: 'x', size: 10 }],
      expires: Date.now() - 1000,
    });
    assert.throws(() => ft.acceptOffer(offer), /expired/);
  });
});

// ---------------------------------------------------------------------------
// MeshFileTransfer — rejectOffer
// ---------------------------------------------------------------------------

describe('MeshFileTransfer rejectOffer', () => {
  it('rejects and emits FILE_REJECT', () => {
    const sent = [];
    const ft = new MeshFileTransfer();
    ft.onSend(msg => sent.push(msg));

    const offer = ft.createOffer('bob', [{ name: 'x', size: 10 }]);
    ft.rejectOffer(offer.transferId, 'No thanks');

    const reject = sent.find(m => m.t === MESH_TYPE.FILE_REJECT);
    assert.ok(reject);
    assert.equal(reject.p.reason, 'No thanks');
  });

  it('marks state as cancelled', () => {
    const ft = new MeshFileTransfer();
    const offer = ft.createOffer('bob', [{ name: 'x', size: 10 }]);
    ft.rejectOffer(offer.transferId);
    const state = ft.getTransfer(offer.transferId);
    assert.equal(state.status, 'cancelled');
  });
});

// ---------------------------------------------------------------------------
// MeshFileTransfer — sendChunks
// ---------------------------------------------------------------------------

describe('MeshFileTransfer sendChunks', () => {
  it('yields chunks with CIDs', async () => {
    const ft = new MeshFileTransfer({ chunkSize: 4 });
    const offer = ft.createOffer('bob', [{ name: 'data.bin', size: 8 }]);
    // Simulate acceptance
    ft.getTransfer(offer.transferId).status = 'accepted';

    const chunks = [];
    const fileData = [new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])];
    for await (const chunk of ft.sendChunks(offer.transferId, fileData)) {
      chunks.push(chunk);
    }

    assert.equal(chunks.length, 2); // 8 bytes / 4 chunk size = 2 chunks
    assert.equal(chunks[0].fileIndex, 0);
    assert.equal(chunks[0].offset, 0);
    assert.equal(chunks[0].data.length, 4);
    assert.equal(chunks[1].offset, 4);
    assert.equal(typeof chunks[0].cid, 'string');
  });

  it('marks transfer as completed when all chunks sent', async () => {
    const ft = new MeshFileTransfer({ chunkSize: 10 });
    const offer = ft.createOffer('bob', [{ name: 'x', size: 5 }]);

    const chunks = [];
    for await (const chunk of ft.sendChunks(offer.transferId, [new Uint8Array(5)])) {
      chunks.push(chunk);
    }

    const state = ft.getTransfer(offer.transferId);
    assert.equal(state.status, 'completed');
  });

  it('emits progress events', async () => {
    const progress = [];
    const ft = new MeshFileTransfer({ chunkSize: 5 });
    ft.onProgress((id, p) => progress.push(p));

    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]); // distinct halves
    const offer = ft.createOffer('bob', [{ name: 'x', size: 10 }]);
    for await (const _ of ft.sendChunks(offer.transferId, [data])) { /* consume */ }

    assert.equal(progress.length, 2);
    assert.equal(progress[0].percentComplete, 50);
    assert.equal(progress[1].percentComplete, 100);
  });

  it('throws for unknown transfer', async () => {
    const ft = new MeshFileTransfer();
    await assert.rejects(async () => {
      for await (const _ of ft.sendChunks('nope', [])) { /* consume */ }
    }, /Unknown transfer/);
  });

  it('handles multi-file transfers', async () => {
    const ft = new MeshFileTransfer({ chunkSize: 4 });
    const offer = ft.createOffer('bob', [
      { name: 'a', size: 4 },
      { name: 'b', size: 4 },
    ]);

    const chunks = [];
    const fileData = [new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6, 7, 8])];
    for await (const chunk of ft.sendChunks(offer.transferId, fileData)) {
      chunks.push(chunk);
    }

    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].fileIndex, 0);
    assert.equal(chunks[1].fileIndex, 1);
  });

  it('stores chunks in the chunk store', async () => {
    const ft = new MeshFileTransfer({ chunkSize: 10 });
    const offer = ft.createOffer('bob', [{ name: 'x', size: 5 }]);

    let chunkCid;
    for await (const chunk of ft.sendChunks(offer.transferId, [new Uint8Array(5)])) {
      chunkCid = chunk.cid;
    }

    assert.ok(ft.store.has(chunkCid));
  });
});

// ---------------------------------------------------------------------------
// MeshFileTransfer — receiveChunk
// ---------------------------------------------------------------------------

describe('MeshFileTransfer receiveChunk', () => {
  it('validates and stores received chunk', async () => {
    const ft = new MeshFileTransfer();
    const offer = new TransferOffer({
      sender: 'alice', recipient: 'bob',
      files: [{ name: 'x', size: 3 }],
    });
    ft.acceptOffer(offer);

    const data = new Uint8Array([10, 20, 30]);
    const cid = await ChunkStore.computeCid(data);
    const valid = await ft.receiveChunk(offer.transferId, 0, cid, data);

    assert.ok(valid);
    assert.ok(ft.store.has(cid));
  });

  it('returns false for invalid CID', async () => {
    const ft = new MeshFileTransfer();
    const offer = new TransferOffer({
      sender: 'a', recipient: 'b',
      files: [{ name: 'x', size: 3 }],
    });
    ft.acceptOffer(offer);

    const valid = await ft.receiveChunk(offer.transferId, 0, 'bad_cid', new Uint8Array([1, 2, 3]));
    assert.ok(!valid);
  });

  it('marks transfer completed when all bytes received', async () => {
    let completed = false;
    const ft = new MeshFileTransfer();
    ft.onComplete(() => { completed = true; });

    const offer = new TransferOffer({
      sender: 'a', recipient: 'b',
      files: [{ name: 'x', size: 5 }],
    });
    ft.acceptOffer(offer);

    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const cid = await ChunkStore.computeCid(data);
    await ft.receiveChunk(offer.transferId, 0, cid, data);

    assert.ok(completed);
    const state = ft.getTransfer(offer.transferId);
    assert.equal(state.status, 'completed');
  });

  it('throws for unknown transfer', async () => {
    const ft = new MeshFileTransfer();
    await assert.rejects(
      () => ft.receiveChunk('nope', 0, 'cid', new Uint8Array([1])),
      /Unknown transfer/,
    );
  });
});

// ---------------------------------------------------------------------------
// MeshFileTransfer — cancelTransfer
// ---------------------------------------------------------------------------

describe('MeshFileTransfer cancelTransfer', () => {
  it('cancels and emits FILE_CANCEL', () => {
    const sent = [];
    const ft = new MeshFileTransfer();
    ft.onSend(msg => sent.push(msg));

    const offer = ft.createOffer('bob', [{ name: 'x', size: 10 }]);
    ft.cancelTransfer(offer.transferId, 'Changed my mind');

    const cancel = sent.find(m => m.t === MESH_TYPE.FILE_CANCEL);
    assert.ok(cancel);
    assert.equal(cancel.p.reason, 'Changed my mind');
  });

  it('does not cancel already completed transfer', () => {
    const ft = new MeshFileTransfer();
    const offer = ft.createOffer('bob', [{ name: 'x', size: 0 }]);
    const state = ft.getTransfer(offer.transferId);
    state.status = 'completed';
    ft.cancelTransfer(offer.transferId);
    assert.equal(state.status, 'completed'); // unchanged
  });
});

// ---------------------------------------------------------------------------
// MeshFileTransfer — listTransfers
// ---------------------------------------------------------------------------

describe('MeshFileTransfer listTransfers', () => {
  it('lists all transfers', () => {
    const ft = new MeshFileTransfer();
    ft.createOffer('bob', [{ name: 'a', size: 10 }]);
    ft.createOffer('carol', [{ name: 'b', size: 20 }]);
    const list = ft.listTransfers();
    assert.equal(list.length, 2);
  });

  it('filters by status', () => {
    const ft = new MeshFileTransfer();
    const offer1 = ft.createOffer('bob', [{ name: 'a', size: 10 }]);
    ft.createOffer('carol', [{ name: 'b', size: 20 }]);
    ft.cancelTransfer(offer1.transferId);

    const cancelled = ft.listTransfers({ status: 'cancelled' });
    assert.equal(cancelled.length, 1);
  });

  it('filters by peerId', () => {
    const ft = new MeshFileTransfer();
    ft.createOffer('bob', [{ name: 'a', size: 10 }], { sender: 'alice' });
    ft.createOffer('carol', [{ name: 'b', size: 20 }], { sender: 'alice' });

    const bobTransfers = ft.listTransfers({ peerId: 'bob' });
    assert.equal(bobTransfers.length, 1);
  });
});

// ---------------------------------------------------------------------------
// MeshFileTransfer — dispatch
// ---------------------------------------------------------------------------

describe('MeshFileTransfer dispatch', () => {
  it('dispatches FILE_OFFER and fires onOffer', () => {
    let received = null;
    const ft = new MeshFileTransfer();
    ft.onOffer(offer => { received = offer; });

    ft.dispatch({
      t: MESH_TYPE.FILE_OFFER,
      p: {
        transferId: 'test_xfer',
        sender: 'alice',
        recipient: 'bob',
        files: [{ name: 'x', size: 10, mimeType: null, cid: null }],
        totalSize: 10,
        expires: Date.now() + 60000,
      },
    });

    assert.ok(received);
    assert.equal(received.transferId, 'test_xfer');
    assert.ok(ft.getOffer('test_xfer'));
  });

  it('dispatches FILE_ACCEPT and updates state', () => {
    const ft = new MeshFileTransfer();
    const offer = ft.createOffer('bob', [{ name: 'x', size: 10 }]);
    ft.dispatch({ t: MESH_TYPE.FILE_ACCEPT, p: { transferId: offer.transferId } });
    assert.equal(ft.getTransfer(offer.transferId).status, 'accepted');
  });

  it('dispatches FILE_REJECT and cancels', () => {
    const ft = new MeshFileTransfer();
    const offer = ft.createOffer('bob', [{ name: 'x', size: 10 }]);
    ft.dispatch({ t: MESH_TYPE.FILE_REJECT, p: { transferId: offer.transferId } });
    assert.equal(ft.getTransfer(offer.transferId).status, 'cancelled');
  });

  it('dispatches FILE_COMPLETE', () => {
    let completed = false;
    const ft = new MeshFileTransfer();
    ft.onComplete(() => { completed = true; });
    const offer = ft.createOffer('bob', [{ name: 'x', size: 10 }]);
    ft.dispatch({ t: MESH_TYPE.FILE_COMPLETE, p: { transferId: offer.transferId } });
    assert.ok(completed);
  });

  it('dispatches FILE_CANCEL', () => {
    const ft = new MeshFileTransfer();
    const offer = ft.createOffer('bob', [{ name: 'x', size: 10 }]);
    ft.dispatch({ t: MESH_TYPE.FILE_CANCEL, p: { transferId: offer.transferId } });
    assert.equal(ft.getTransfer(offer.transferId).status, 'cancelled');
  });

  it('ignores null/undefined messages', () => {
    const ft = new MeshFileTransfer();
    ft.dispatch(null);
    ft.dispatch(undefined);
    ft.dispatch({});
  });

  it('accepts envelope format { _mesh, payload }', () => {
    let received = null;
    const ft = new MeshFileTransfer();
    ft.onOffer(offer => { received = offer; });

    ft.dispatch({
      _mesh: 'file-transfer',
      payload: {
        t: MESH_TYPE.FILE_OFFER,
        p: {
          transferId: 'env_xfer',
          sender: 'alice',
          recipient: 'bob',
          files: [{ name: 'env.txt', size: 99 }],
          totalSize: 99,
          expires: Date.now() + 60000,
        },
      },
    });

    assert.ok(received, 'onOffer should fire from envelope format');
    assert.equal(received.transferId, 'env_xfer');
    assert.ok(ft.getOffer('env_xfer'));
  });
});

// ---------------------------------------------------------------------------
// MeshFileTransfer — end-to-end
// ---------------------------------------------------------------------------

describe('MeshFileTransfer end-to-end', () => {
  it('sender and receiver complete a transfer', async () => {
    const sender = new MeshFileTransfer({ chunkSize: 4 });
    const receiver = new MeshFileTransfer({ chunkSize: 4 });

    // Wire them
    sender.onSend(msg => receiver.dispatch(msg));
    receiver.onSend(msg => sender.dispatch(msg));

    // Receiver accepts offers
    let receivedOffer = null;
    receiver.onOffer(offer => {
      receivedOffer = offer;
      receiver.acceptOffer(offer);
    });

    // Create offer
    const offer = sender.createOffer('bob', [{ name: 'test.bin', size: 8 }], { sender: 'alice' });
    assert.ok(receivedOffer);

    // Wait for acceptance
    assert.equal(sender.getTransfer(offer.transferId).status, 'accepted');

    // Send chunks
    const fileData = [new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80])];
    for await (const chunk of sender.sendChunks(offer.transferId, fileData)) {
      await receiver.receiveChunk(offer.transferId, chunk.fileIndex, chunk.cid, chunk.data);
    }

    assert.equal(receiver.getTransfer(offer.transferId).status, 'completed');
  });
});

// ---------------------------------------------------------------------------
// MeshFileTransfer — serialization
// ---------------------------------------------------------------------------

describe('MeshFileTransfer toJSON/fromJSON', () => {
  it('round-trips offers via JSON', () => {
    const ft = new MeshFileTransfer();
    ft.createOffer('bob', [{ name: 'a.txt', size: 100 }], { sender: 'alice' });

    const json = ft.toJSON();
    assert.ok(Object.keys(json.offers).length === 1);
    assert.ok(Object.keys(json.states).length === 1);

    const restored = MeshFileTransfer.fromJSON(json);
    const offerId = Object.keys(json.offers)[0];
    assert.ok(restored.getOffer(offerId));
  });
});
