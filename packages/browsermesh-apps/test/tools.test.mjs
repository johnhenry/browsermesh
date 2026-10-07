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
  IoTListTool,
  IoTSendTool,
  IoTTelemetryTool,
  registerMeshTools,
} from '../src/tools.mjs';
import { StreamMultiplexer } from '@johnhenry/browsermesh-transport';
import { MeshFileTransfer, TransferOffer } from '@johnhenry/browsermesh-sync';
import { BrowserTool, BrowserToolRegistry } from '../src/compat.mjs';

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
  const noIot = [
    'mesh_stream_open', 'mesh_stream_close', 'mesh_stream_list',
    'mesh_file_send', 'mesh_file_accept', 'mesh_file_list', 'mesh_file_cancel',
    'dht_store', 'dht_lookup', 'dht_peers', 'gpu_train_start', 'gpu_train_status',
  ];
  const iotBridge = {
    listDevices: () => [{ deviceId: 'd1', name: 'lamp', protocol: 'mqtt', capabilities: ['read', 'write'] }],
    send: async () => {},
  };
  const iotTelemetry = {
    query: () => [{ ts: 1700000000000, value: 21.5 }],
    getStats: () => ({ min: 20, max: 22, avg: 21, count: 2, last: 21.5 }),
  };
  const collect = (...args) => {
    const registered = [];
    registerMeshTools({ register(tool) { registered.push(tool); } }, ...args);
    return registered.map(t => t.name);
  };

  beforeEach(() => {
    meshToolsContext.setIoTBridge(null);
    meshToolsContext.setIoTTelemetry(null);
  });

  it('registers the 12 non-IoT tools by default and no IoT tools (#192)', () => {
    const names = collect();
    assert.deepEqual(names, noIot);
    assert.ok(!names.some(n => n.startsWith('iot_')));
  });

  it('registers iot_list and iot_send only when an iotBridge is supplied', () => {
    const names = collect(undefined, undefined, { iotBridge });
    assert.deepEqual(names, [...noIot, 'iot_list', 'iot_send']);
    assert.equal(meshToolsContext.getIoTBridge(), iotBridge);
  });

  it('registers iot_telemetry only when iotTelemetry is supplied', () => {
    const names = collect(undefined, undefined, { iotTelemetry });
    assert.deepEqual(names, [...noIot, 'iot_telemetry']);
    assert.equal(meshToolsContext.getIoTTelemetry(), iotTelemetry);
  });

  it('registers all 15 tools when both are supplied', () => {
    const names = collect(undefined, undefined, { iotBridge, iotTelemetry });
    assert.equal(names.length, 15);
    for (const n of ['iot_list', 'iot_send', 'iot_telemetry']) assert.ok(names.includes(n));
  });

  it('rejects a bridge or telemetry that does not implement the documented duck type', () => {
    assert.throws(() => collect(undefined, undefined, { iotBridge: { listDevices() {} } }), /iotBridge must implement send\(\)/);
    assert.throws(() => collect(undefined, undefined, { iotBridge: {} }), /iotBridge must implement listDevices\(\)/);
    assert.throws(() => collect(undefined, undefined, { iotTelemetry: { query() {} } }), /iotTelemetry must implement getStats\(\)/);
  });

  it('the supplied bridge drives the tools end to end', async () => {
    const sent = [];
    registerMeshTools({ register() {} }, undefined, undefined, {
      iotBridge: { ...iotBridge, send: async (id, payload) => { sent.push([id, payload]); } },
      iotTelemetry,
    });
    const list = await new IoTListTool().execute({ protocol: 'mqtt' });
    assert.equal(list.success, true);
    assert.match(list.output, /d1 \| lamp \| mqtt \| \[read,write\]/);
    const send = await new IoTSendTool().execute({ deviceId: 'd1', payload: { on: true } });
    assert.equal(send.success, true);
    assert.deepEqual(sent, [['d1', { on: true }]]);
    const stats = await new IoTTelemetryTool().execute({ deviceId: 'd1', stats: true });
    assert.match(stats.output, /min=20 max=22 avg=21\.00 count=2 last=21\.5/);
  });

  it('sets context when multiplexer and fileTransfer provided', () => {
    const mux = new StreamMultiplexer();
    const ft = new MeshFileTransfer();
    const registry = { register() {} };
    registerMeshTools(registry, mux, ft);
    assert.equal(meshToolsContext.getMultiplexer(), mux);
    assert.equal(meshToolsContext.getFileTransfer(), ft);
  });

  it('registers the tools into a real BrowserToolRegistry', () => {
    const registry = new BrowserToolRegistry();
    registerMeshTools(registry, undefined, undefined, { iotBridge, iotTelemetry });
    assert.equal(registry.list().length, 15);
    assert.ok(registry.get('mesh_stream_open') instanceof MeshStreamOpenTool);
    const specs = registry.listSpecs();
    assert.ok(specs.some((s) => s.name === 'iot_telemetry'));

    const bare = new BrowserToolRegistry();
    registerMeshTools(bare);
    assert.equal(bare.list().length, 12);
    assert.ok(!bare.listSpecs().some((s) => s.name.startsWith('iot_')));
  });
});
