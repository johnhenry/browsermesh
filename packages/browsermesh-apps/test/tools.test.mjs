// Run with: node --import ./test/_setup-globals.mjs --test test/tools.test.mjs
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  MeshToolsContext,
  meshToolsContext,
  MeshStreamOpenTool,
  MeshStreamCloseTool,
  MeshStreamListTool,
  MeshFileSendTool,
  MeshFileAcceptTool,
  MeshFileListTool,
  MeshFileCancelTool,
  registerMeshTools,
} from '../src/tools.mjs';
import { StreamMultiplexer } from '@johnhenry/browsermesh-transport';
import { MeshFileTransfer, TransferOffer } from '@johnhenry/browsermesh-sync';
import { BrowserTool } from '../src/compat.mjs';

// ---------------------------------------------------------------------------
// MeshToolsContext
// ---------------------------------------------------------------------------

describe('MeshToolsContext', () => {
  it('starts with null multiplexer and fileTransfer', () => {
    const ctx = new MeshToolsContext();
    assert.equal(ctx.getMultiplexer(), null);
    assert.equal(ctx.getFileTransfer(), null);
  });

  it('stores and retrieves multiplexer', () => {
    const ctx = new MeshToolsContext();
    const mux = new StreamMultiplexer();
    ctx.setMultiplexer(mux);
    assert.equal(ctx.getMultiplexer(), mux);
  });

  it('stores and retrieves fileTransfer', () => {
    const ctx = new MeshToolsContext();
    const ft = new MeshFileTransfer();
    ctx.setFileTransfer(ft);
    assert.equal(ctx.getFileTransfer(), ft);
  });
});

// ---------------------------------------------------------------------------
// Tool class basics
// ---------------------------------------------------------------------------

describe('Tool class basics', () => {
  const tools = [
    new MeshStreamOpenTool(),
    new MeshStreamCloseTool(),
    new MeshStreamListTool(),
    new MeshFileSendTool(),
    new MeshFileAcceptTool(),
    new MeshFileListTool(),
    new MeshFileCancelTool(),
  ];

  it('all extend BrowserTool', () => {
    for (const tool of tools) {
      assert.ok(tool instanceof BrowserTool, `${tool.name} should extend BrowserTool`);
    }
  });

  it('all have unique names', () => {
    const names = tools.map(t => t.name);
    assert.equal(new Set(names).size, names.length);
  });

  it('all have descriptions', () => {
    for (const tool of tools) {
      assert.ok(tool.description.length > 0, `${tool.name} needs description`);
    }
  });

  it('all have correct permission levels', () => {
    const expected = {
      mesh_stream_open: 'network',
      mesh_stream_close: 'network',
      mesh_stream_list: 'read',
      mesh_file_send: 'approve',
      mesh_file_accept: 'approve',
      mesh_file_list: 'read',
      mesh_file_cancel: 'write',
    };
    for (const tool of tools) {
      assert.equal(tool.permission, expected[tool.name], `${tool.name} permission`);
    }
  });

  it('all have parameters with type object', () => {
    for (const tool of tools) {
      assert.equal(tool.parameters.type, 'object', `${tool.name} params`);
    }
  });

  it('all have spec objects', () => {
    for (const tool of tools) {
      const spec = tool.spec;
      assert.equal(spec.name, tool.name);
      assert.equal(spec.description, tool.description);
    }
  });
});

// ---------------------------------------------------------------------------
// MeshStreamOpenTool
// ---------------------------------------------------------------------------

describe('MeshStreamOpenTool', () => {
  let tool;

  beforeEach(() => {
    tool = new MeshStreamOpenTool();
    meshToolsContext.setMultiplexer(new StreamMultiplexer());
  });

  it('opens a stream and returns success', async () => {
    const result = await tool.execute({ peerId: 'bob', method: 'chat' });
    assert.ok(result.success);
    assert.match(result.output, /Stream opened/);
    assert.match(result.output, /chat/);
  });

  it('passes ordered and encrypted options', async () => {
    const result = await tool.execute({ peerId: 'bob', method: 'rpc', ordered: false, encrypted: true });
    assert.ok(result.success);
    assert.match(result.output, /ordered: false/);
    assert.match(result.output, /encrypted: true/);
  });

  it('returns error when multiplexer not set', async () => {
    meshToolsContext.setMultiplexer(null);
    const result = await tool.execute({ peerId: 'bob', method: 'test' });
    assert.ok(!result.success);
    assert.match(result.error, /not initialized/);
  });

  it('returns error on concurrent limit', async () => {
    meshToolsContext.setMultiplexer(new StreamMultiplexer({ maxConcurrentStreams: 1 }));
    await tool.execute({ peerId: 'bob', method: 'a' });
    const result = await tool.execute({ peerId: 'bob', method: 'b' });
    assert.ok(!result.success);
    assert.match(result.error, /limit/i);
  });
});

// ---------------------------------------------------------------------------
// MeshStreamCloseTool
// ---------------------------------------------------------------------------

describe('MeshStreamCloseTool', () => {
  let tool, mux;

  beforeEach(() => {
    tool = new MeshStreamCloseTool();
    mux = new StreamMultiplexer();
    meshToolsContext.setMultiplexer(mux);
  });

  it('closes an existing stream', async () => {
    const stream = mux.open('test');
    const result = await tool.execute({ streamId: stream.hexId });
    assert.ok(result.success);
    assert.match(result.output, /closed/);
  });

  it('returns error for unknown stream', async () => {
    const result = await tool.execute({ streamId: 'nonexistent' });
    assert.ok(!result.success);
    assert.match(result.error, /not found/);
  });

  it('returns error when multiplexer not set', async () => {
    meshToolsContext.setMultiplexer(null);
    const result = await tool.execute({ streamId: 'abc' });
    assert.ok(!result.success);
    assert.match(result.error, /not initialized/);
  });
});

// ---------------------------------------------------------------------------
// MeshStreamListTool
// ---------------------------------------------------------------------------

describe('MeshStreamListTool', () => {
  let tool, mux;

  beforeEach(() => {
    tool = new MeshStreamListTool();
    mux = new StreamMultiplexer();
    meshToolsContext.setMultiplexer(mux);
  });

  it('lists active streams', async () => {
    mux.open('upload');
    mux.open('download');
    const result = await tool.execute();
    assert.ok(result.success);
    assert.match(result.output, /upload/);
    assert.match(result.output, /download/);
  });

  it('returns empty message when no streams', async () => {
    const result = await tool.execute();
    assert.ok(result.success);
    assert.match(result.output, /No active streams/);
  });

  it('returns message when multiplexer not set', async () => {
    meshToolsContext.setMultiplexer(null);
    const result = await tool.execute();
    assert.ok(result.success);
    assert.match(result.output, /not initialized/);
  });
});

// ---------------------------------------------------------------------------
// MeshFileSendTool
// ---------------------------------------------------------------------------

describe('MeshFileSendTool', () => {
  let tool;

  beforeEach(() => {
    tool = new MeshFileSendTool();
    meshToolsContext.setFileTransfer(new MeshFileTransfer());
  });

  it('creates a transfer offer', async () => {
    const result = await tool.execute({
      peerId: 'bob',
      files: [{ name: 'photo.jpg', size: 1024 }],
    });
    assert.ok(result.success);
    assert.match(result.output, /Transfer offer created/);
    assert.match(result.output, /photo\.jpg/);
    assert.match(result.output, /1024 bytes/);
  });

  it('handles multiple files', async () => {
    const result = await tool.execute({
      peerId: 'bob',
      files: [
        { name: 'a.txt', size: 100 },
        { name: 'b.txt', size: 200 },
      ],
    });
    assert.ok(result.success);
    assert.match(result.output, /a\.txt/);
    assert.match(result.output, /b\.txt/);
    assert.match(result.output, /300 bytes/);
  });

  it('returns error when file transfer not set', async () => {
    meshToolsContext.setFileTransfer(null);
    const result = await tool.execute({ peerId: 'bob', files: [{ name: 'x', size: 10 }] });
    assert.ok(!result.success);
    assert.match(result.error, /not initialized/);
  });
});

// ---------------------------------------------------------------------------
// MeshFileAcceptTool
// ---------------------------------------------------------------------------

describe('MeshFileAcceptTool', () => {
  let tool, ft;

  beforeEach(() => {
    tool = new MeshFileAcceptTool();
    ft = new MeshFileTransfer();
    meshToolsContext.setFileTransfer(ft);
  });

  it('accepts a pending offer', async () => {
    // Simulate an incoming offer
    const offer = new TransferOffer({
      sender: 'alice', recipient: 'bob',
      files: [{ name: 'x.txt', size: 100 }],
    });
    ft.dispatch({ t: 0xb8, p: offer.toJSON() });

    const result = await tool.execute({ transferId: offer.transferId });
    assert.ok(result.success);
    assert.match(result.output, /accepted/);
  });

  it('returns error for unknown transfer', async () => {
    const result = await tool.execute({ transferId: 'nope' });
    assert.ok(!result.success);
    assert.match(result.error, /not found/);
  });

  it('returns error when file transfer not set', async () => {
    meshToolsContext.setFileTransfer(null);
    const result = await tool.execute({ transferId: 'abc' });
    assert.ok(!result.success);
    assert.match(result.error, /not initialized/);
  });
});

// ---------------------------------------------------------------------------
// MeshFileListTool
// ---------------------------------------------------------------------------

describe('MeshFileListTool', () => {
  let tool, ft;

  beforeEach(() => {
    tool = new MeshFileListTool();
    ft = new MeshFileTransfer();
    meshToolsContext.setFileTransfer(ft);
  });

  it('lists transfers', async () => {
    ft.createOffer('bob', [{ name: 'a.txt', size: 10 }]);
    const result = await tool.execute();
    assert.ok(result.success);
    assert.match(result.output, /a\.txt/);
  });

  it('returns empty when no transfers', async () => {
    const result = await tool.execute();
    assert.ok(result.success);
    assert.match(result.output, /No transfers/);
  });

  it('filters by status', async () => {
    const offer = ft.createOffer('bob', [{ name: 'a', size: 10 }]);
    ft.cancelTransfer(offer.transferId);
    const result = await tool.execute({ status: 'cancelled' });
    assert.ok(result.success);
    assert.match(result.output, /cancelled/);
  });

  it('returns message when file transfer not set', async () => {
    meshToolsContext.setFileTransfer(null);
    const result = await tool.execute();
    assert.ok(result.success);
    assert.match(result.output, /not initialized/);
  });
});

// ---------------------------------------------------------------------------
// MeshFileCancelTool
// ---------------------------------------------------------------------------

describe('MeshFileCancelTool', () => {
  let tool, ft;

  beforeEach(() => {
    tool = new MeshFileCancelTool();
    ft = new MeshFileTransfer();
    meshToolsContext.setFileTransfer(ft);
  });

  it('cancels a transfer', async () => {
    const offer = ft.createOffer('bob', [{ name: 'x', size: 10 }]);
    const result = await tool.execute({ transferId: offer.transferId, reason: 'No longer needed' });
    assert.ok(result.success);
    assert.match(result.output, /cancelled/);
    assert.match(result.output, /No longer needed/);
  });

  it('cancels without reason', async () => {
    const offer = ft.createOffer('bob', [{ name: 'x', size: 10 }]);
    const result = await tool.execute({ transferId: offer.transferId });
    assert.ok(result.success);
    assert.match(result.output, /cancelled/);
  });

  it('returns error when file transfer not set', async () => {
    meshToolsContext.setFileTransfer(null);
    const result = await tool.execute({ transferId: 'abc' });
    assert.ok(!result.success);
    assert.match(result.error, /not initialized/);
  });
});

// ---------------------------------------------------------------------------
// registerMeshTools
// ---------------------------------------------------------------------------

describe('registerMeshTools', () => {
  it('registers all 15 tools', () => {
    const registered = [];
    const registry = { register(tool) { registered.push(tool); } };
    registerMeshTools(registry);
    assert.equal(registered.length, 15);
    const names = registered.map(t => t.name);
    assert.ok(names.includes('mesh_stream_open'));
    assert.ok(names.includes('mesh_stream_close'));
    assert.ok(names.includes('mesh_stream_list'));
    assert.ok(names.includes('mesh_file_send'));
    assert.ok(names.includes('mesh_file_accept'));
    assert.ok(names.includes('mesh_file_list'));
    assert.ok(names.includes('mesh_file_cancel'));
    assert.ok(names.includes('dht_store'));
    assert.ok(names.includes('dht_lookup'));
    assert.ok(names.includes('dht_peers'));
    assert.ok(names.includes('gpu_train_start'));
    assert.ok(names.includes('gpu_train_status'));
    assert.ok(names.includes('iot_list'));
    assert.ok(names.includes('iot_send'));
    assert.ok(names.includes('iot_telemetry'));
  });

  it('sets context when multiplexer and fileTransfer provided', () => {
    const mux = new StreamMultiplexer();
    const ft = new MeshFileTransfer();
    const registry = { register() {} };
    registerMeshTools(registry, mux, ft);
    assert.equal(meshToolsContext.getMultiplexer(), mux);
    assert.equal(meshToolsContext.getFileTransfer(), ft);
  });
});
