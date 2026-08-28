/**
 * Clawser Mesh Tools
 *
 * BrowserTool subclasses exposing mesh stream and file transfer operations
 * to the AI agent. Follows the pattern in clawser-wsh-tools.js.
 *
 * @module clawser-mesh-tools
 */

import { BrowserTool } from './compat.mjs';

// ── Shared state ─────────────────────────────────────────────────────

/**
 * Holds references to the StreamMultiplexer and MeshFileTransfer instances
 * so tools can access them without import cycles.
 */
export class MeshToolsContext {
  #multiplexer = null;
  #fileTransfer = null;
  #dhtNode = null;
  #trainingOrchestrator = null;
  #iotBridge = null;
  #iotTelemetry = null;

  setMultiplexer(mux) { this.#multiplexer = mux; }
  getMultiplexer() { return this.#multiplexer; }

  setFileTransfer(ft) { this.#fileTransfer = ft; }
  getFileTransfer() { return this.#fileTransfer; }

  setDhtNode(node) { this.#dhtNode = node; }
  getDhtNode() { return this.#dhtNode; }

  setTrainingOrchestrator(orch) { this.#trainingOrchestrator = orch; }
  getTrainingOrchestrator() { return this.#trainingOrchestrator; }

  setIoTBridge(bridge) { this.#iotBridge = bridge; }
  getIoTBridge() { return this.#iotBridge; }

  setIoTTelemetry(telemetry) { this.#iotTelemetry = telemetry; }
  getIoTTelemetry() { return this.#iotTelemetry; }
}

/** Singleton context for mesh tools. */
export const meshToolsContext = new MeshToolsContext();

// ── mesh_stream_open ─────────────────────────────────────────────────

export class MeshStreamOpenTool extends BrowserTool {
  get name() { return 'mesh_stream_open'; }
  get description() {
    return 'Open a multiplexed data stream to a peer. Returns the stream ID for subsequent read/write operations.';
  }
  get parameters() {
    return {
      type: 'object',
      properties: {
        peerId: { type: 'string', description: 'Target peer identity' },
        method: { type: 'string', description: 'Stream purpose (e.g., "chat", "storage/upload")' },
        ordered: { type: 'boolean', description: 'Whether delivery must be ordered (default: true)' },
        encrypted: { type: 'boolean', description: 'Whether to use per-stream encryption (default: false)' },
      },
      required: ['peerId', 'method'],
    };
  }
  get permission() { return 'network'; }

  async execute({ peerId, method, ordered, encrypted }) {
    try {
      const mux = meshToolsContext.getMultiplexer();
      if (!mux) {
        return { success: false, output: '', error: 'Stream multiplexer not initialized. Start a mesh session first.' };
      }

      const stream = mux.open(method, { ordered, encrypted });
      return {
        success: true,
        output: `Stream opened: ${stream.hexId} (method: ${method}, peer: ${peerId}, ordered: ${stream.ordered}, encrypted: ${stream.encrypted})`,
      };
    } catch (err) {
      return { success: false, output: '', error: `Stream open failed: ${err.message}` };
    }
  }
}

// ── mesh_stream_close ────────────────────────────────────────────────

export class MeshStreamCloseTool extends BrowserTool {
  get name() { return 'mesh_stream_close'; }
  get description() {
    return 'Close an open data stream by ID.';
  }
  get parameters() {
    return {
      type: 'object',
      properties: {
        streamId: { type: 'string', description: 'Hex stream ID to close' },
      },
      required: ['streamId'],
    };
  }
  get permission() { return 'network'; }

  async execute({ streamId }) {
    try {
      const mux = meshToolsContext.getMultiplexer();
      if (!mux) {
        return { success: false, output: '', error: 'Stream multiplexer not initialized.' };
      }

      const stream = mux.getStream(streamId);
      if (!stream) {
        return { success: false, output: '', error: `Stream ${streamId} not found.` };
      }

      mux.close(streamId);
      return { success: true, output: `Stream ${streamId} closed.` };
    } catch (err) {
      return { success: false, output: '', error: `Stream close failed: ${err.message}` };
    }
  }
}

// ── mesh_stream_list ─────────────────────────────────────────────────

export class MeshStreamListTool extends BrowserTool {
  get name() { return 'mesh_stream_list'; }
  get description() {
    return 'List active mesh streams, optionally filtered by peer.';
  }
  get parameters() {
    return {
      type: 'object',
      properties: {
        peerId: { type: 'string', description: 'Filter by peer identity (optional)' },
      },
    };
  }
  get permission() { return 'read'; }

  async execute({ peerId } = {}) {
    try {
      const mux = meshToolsContext.getMultiplexer();
      if (!mux) {
        return { success: true, output: 'No active streams (multiplexer not initialized).' };
      }

      const streams = mux.listStreams();
      if (streams.length === 0) {
        return { success: true, output: 'No active streams.' };
      }

      const lines = streams.map(s => {
        const json = s.toJSON();
        return `${json.id} | ${json.method} | ${json.state} | sent:${json.bytesSent} recv:${json.bytesReceived}`;
      });
      return {
        success: true,
        output: `ID | METHOD | STATE | BYTES\n${lines.join('\n')}`,
      };
    } catch (err) {
      return { success: false, output: '', error: err.message };
    }
  }
}

// ── mesh_file_send ───────────────────────────────────────────────────

export class MeshFileSendTool extends BrowserTool {
  get name() { return 'mesh_file_send'; }
  get description() {
    return 'Send files to a peer. Creates a transfer offer with file metadata. The peer must accept before data is sent.';
  }
  get parameters() {
    return {
      type: 'object',
      properties: {
        peerId: { type: 'string', description: 'Recipient peer identity' },
        files: {
          type: 'array',
          description: 'Files to send: [{ name, size, mimeType? }]',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              size: { type: 'number' },
              mimeType: { type: 'string' },
            },
            required: ['name', 'size'],
          },
        },
      },
      required: ['peerId', 'files'],
    };
  }
  get permission() { return 'approve'; }

  async execute({ peerId, files }) {
    try {
      const ft = meshToolsContext.getFileTransfer();
      if (!ft) {
        return { success: false, output: '', error: 'File transfer not initialized. Start a mesh session first.' };
      }

      const offer = ft.createOffer(peerId, files);
      const fileList = offer.files.map(f => `  ${f.name} (${f.size} bytes)`).join('\n');
      return {
        success: true,
        output: `Transfer offer created: ${offer.transferId}\nRecipient: ${peerId}\nFiles:\n${fileList}\nTotal: ${offer.totalSize} bytes\nWaiting for acceptance...`,
      };
    } catch (err) {
      return { success: false, output: '', error: `File send failed: ${err.message}` };
    }
  }
}

// ── mesh_file_accept ─────────────────────────────────────────────────

export class MeshFileAcceptTool extends BrowserTool {
  get name() { return 'mesh_file_accept'; }
  get description() {
    return 'Accept an incoming file transfer offer.';
  }
  get parameters() {
    return {
      type: 'object',
      properties: {
        transferId: { type: 'string', description: 'Transfer ID from the incoming offer' },
      },
      required: ['transferId'],
    };
  }
  get permission() { return 'approve'; }

  async execute({ transferId }) {
    try {
      const ft = meshToolsContext.getFileTransfer();
      if (!ft) {
        return { success: false, output: '', error: 'File transfer not initialized.' };
      }

      const offer = ft.getOffer(transferId);
      if (!offer) {
        return { success: false, output: '', error: `Transfer offer ${transferId} not found.` };
      }

      const state = ft.acceptOffer(offer);
      return {
        success: true,
        output: `Transfer ${transferId} accepted. Status: ${state.status}`,
      };
    } catch (err) {
      return { success: false, output: '', error: `Accept failed: ${err.message}` };
    }
  }
}

// ── mesh_file_list ───────────────────────────────────────────────────

export class MeshFileListTool extends BrowserTool {
  get name() { return 'mesh_file_list'; }
  get description() {
    return 'List file transfers, optionally filtered by status or peer.';
  }
  get parameters() {
    return {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status: offered, accepted, transferring, completed, failed, cancelled' },
        peerId: { type: 'string', description: 'Filter by peer identity (optional)' },
      },
    };
  }
  get permission() { return 'read'; }

  async execute({ status, peerId } = {}) {
    try {
      const ft = meshToolsContext.getFileTransfer();
      if (!ft) {
        return { success: true, output: 'No transfers (file transfer not initialized).' };
      }

      const transfers = ft.listTransfers({ status, peerId });
      if (transfers.length === 0) {
        return { success: true, output: 'No transfers found.' };
      }

      const lines = transfers.map(t => {
        const s = t.state;
        const fileNames = t.offer?.files?.map(f => f.name).join(', ') || '?';
        return `${s.transferId} | ${s.status} | ${fileNames} | ${s.bytesTransferred}/${s.totalSize} (${Math.round(s.percentComplete)}%)`;
      });
      return {
        success: true,
        output: `ID | STATUS | FILES | PROGRESS\n${lines.join('\n')}`,
      };
    } catch (err) {
      return { success: false, output: '', error: err.message };
    }
  }
}

// ── mesh_file_cancel ─────────────────────────────────────────────────

export class MeshFileCancelTool extends BrowserTool {
  get name() { return 'mesh_file_cancel'; }
  get description() {
    return 'Cancel an in-progress file transfer.';
  }
  get parameters() {
    return {
      type: 'object',
      properties: {
        transferId: { type: 'string', description: 'Transfer ID to cancel' },
        reason: { type: 'string', description: 'Cancellation reason (optional)' },
      },
      required: ['transferId'],
    };
  }
  get permission() { return 'write'; }

  async execute({ transferId, reason }) {
    try {
      const ft = meshToolsContext.getFileTransfer();
      if (!ft) {
        return { success: false, output: '', error: 'File transfer not initialized.' };
      }

      ft.cancelTransfer(transferId, reason);
      return {
        success: true,
        output: `Transfer ${transferId} cancelled${reason ? ': ' + reason : ''}.`,
      };
    } catch (err) {
      return { success: false, output: '', error: `Cancel failed: ${err.message}` };
    }
  }
}

// ── dht_store ────────────────────────────────────────────────────────

export class DhtStoreTool extends BrowserTool {
  get name() { return 'dht_store'; }
  get description() {
    return 'Store a key-value pair in the distributed hash table (DHT).';
  }
  get parameters() {
    return {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key to store' },
        value: { type: 'string', description: 'Value to store' },
        ttl: { type: 'number', description: 'Time-to-live in milliseconds (optional)' },
      },
      required: ['key', 'value'],
    };
  }
  get permission() { return 'network'; }

  async execute({ key, value, ttl }) {
    try {
      const dht = meshToolsContext.getDhtNode();
      if (!dht) {
        return { success: false, output: '', error: 'DHT node not initialized. Start a mesh session first.' };
      }
      dht.store(key, value, ttl);
      return { success: true, output: `Stored key "${key}" in DHT${ttl ? ` (TTL: ${ttl}ms)` : ''}.` };
    } catch (err) {
      return { success: false, output: '', error: `DHT store failed: ${err.message}` };
    }
  }
}

// ── dht_lookup ───────────────────────────────────────────────────────

export class DhtLookupTool extends BrowserTool {
  get name() { return 'dht_lookup'; }
  get description() {
    return 'Look up a value by key in the distributed hash table (DHT).';
  }
  get parameters() {
    return {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key to look up' },
      },
      required: ['key'],
    };
  }
  get permission() { return 'read'; }

  async execute({ key }) {
    try {
      const dht = meshToolsContext.getDhtNode();
      if (!dht) {
        return { success: false, output: '', error: 'DHT node not initialized. Start a mesh session first.' };
      }
      const result = dht.findValue(key);
      if (result.found) {
        return { success: true, output: `Key "${key}" = ${JSON.stringify(result.value)}` };
      }
      return { success: true, output: `Key "${key}" not found. Closest nodes: ${result.closest.map(c => c.podId).join(', ')}` };
    } catch (err) {
      return { success: false, output: '', error: `DHT lookup failed: ${err.message}` };
    }
  }
}

// ── dht_peers ────────────────────────────────────────────────────────

export class DhtPeersTool extends BrowserTool {
  get name() { return 'dht_peers'; }
  get description() {
    return 'List peers in the DHT routing table.';
  }
  get parameters() {
    return {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Max number of peers to return (default: 20)' },
      },
    };
  }
  get permission() { return 'read'; }

  async execute({ count = 20 } = {}) {
    try {
      const dht = meshToolsContext.getDhtNode();
      if (!dht) {
        return { success: true, output: 'DHT node not initialized.' };
      }
      const peers = dht.findNode(dht.localId || 'self').slice(0, count);
      if (peers.length === 0) {
        return { success: true, output: 'No peers in routing table.' };
      }
      const lines = peers.map(p => `${p.podId}${p.address ? ' @ ' + p.address : ''}`);
      return { success: true, output: `DHT peers (${peers.length}):\n${lines.join('\n')}` };
    } catch (err) {
      return { success: false, output: '', error: `DHT peers failed: ${err.message}` };
    }
  }
}

// ── gpu_train_start ──────────────────────────────────────────────────

export class GpuTrainStartTool extends BrowserTool {
  get name() { return 'gpu_train_start'; }
  get description() {
    return 'Start a distributed GPU training job across mesh peers.';
  }
  get parameters() {
    return {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'Unique job identifier' },
        modelConfig: { type: 'object', description: 'Model architecture configuration' },
        datasetRef: { type: 'string', description: 'Reference to training dataset' },
        epochs: { type: 'number', description: 'Number of training epochs (default: 1)' },
        batchSize: { type: 'number', description: 'Batch size (default: 32)' },
        learningRate: { type: 'number', description: 'Learning rate (default: 0.001)' },
        strategy: { type: 'string', description: 'Training strategy: sync_allreduce, async_parameter_server, or federated_avg' },
        shardCount: { type: 'number', description: 'Number of training shards (default: 1)' },
      },
      required: ['jobId', 'modelConfig', 'datasetRef'],
    };
  }
  get permission() { return 'approve'; }

  async execute({ jobId, modelConfig, datasetRef, epochs, batchSize, learningRate, strategy, shardCount }) {
    try {
      const orch = meshToolsContext.getTrainingOrchestrator();
      if (!orch) {
        return { success: false, output: '', error: 'Training orchestrator not initialized. Start a mesh session first.' };
      }
      const { TrainingSpec } = await import('./gpu.mjs');
      const spec = new TrainingSpec({ jobId, modelConfig, datasetRef, epochs, batchSize, learningRate, strategy, shardCount });
      const id = orch.startJob(spec);
      return { success: true, output: `Training job started: ${id}` };
    } catch (err) {
      return { success: false, output: '', error: `Training start failed: ${err.message}` };
    }
  }
}

// ── gpu_train_status ─────────────────────────────────────────────────

export class GpuTrainStatusTool extends BrowserTool {
  get name() { return 'gpu_train_status'; }
  get description() {
    return 'Check the status of a distributed GPU training job.';
  }
  get parameters() {
    return {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'Job identifier to check' },
      },
      required: ['jobId'],
    };
  }
  get permission() { return 'read'; }

  async execute({ jobId }) {
    try {
      const orch = meshToolsContext.getTrainingOrchestrator();
      if (!orch) {
        return { success: false, output: '', error: 'Training orchestrator not initialized.' };
      }
      const status = orch.getJobStatus(jobId);
      if (!status) {
        return { success: false, output: '', error: `Job ${jobId} not found.` };
      }
      return {
        success: true,
        output: `Job: ${status.jobId} | Status: ${status.status} | Shards: ${status.completedShards}/${status.shardCount}${status.aggregated ? ' | Aggregated' : ''}`,
      };
    } catch (err) {
      return { success: false, output: '', error: `Status check failed: ${err.message}` };
    }
  }
}

// ── iot_list ─────────────────────────────────────────────────────────

export class IoTListTool extends BrowserTool {
  get name() { return 'iot_list'; }
  get description() {
    return 'List registered IoT devices, optionally filtered by protocol or capability.';
  }
  get parameters() {
    return {
      type: 'object',
      properties: {
        protocol: { type: 'string', description: 'Filter by protocol: mqtt, http, direct, coap' },
        capability: { type: 'string', description: 'Filter by capability: read, write, stream, command' },
      },
    };
  }
  get permission() { return 'read'; }

  async execute({ protocol, capability } = {}) {
    try {
      const bridge = meshToolsContext.getIoTBridge();
      if (!bridge) {
        return { success: true, output: 'IoT bridge not initialized.' };
      }
      const filter = {};
      if (protocol) filter.protocol = protocol;
      if (capability) filter.capability = capability;
      const devices = bridge.listDevices(Object.keys(filter).length ? filter : undefined);
      if (devices.length === 0) {
        return { success: true, output: 'No IoT devices found.' };
      }
      const lines = devices.map(d => `${d.deviceId} | ${d.name || '(unnamed)'} | ${d.protocol} | [${d.capabilities.join(',')}]`);
      return { success: true, output: `ID | NAME | PROTOCOL | CAPABILITIES\n${lines.join('\n')}` };
    } catch (err) {
      return { success: false, output: '', error: err.message };
    }
  }
}

// ── iot_send ─────────────────────────────────────────────────────────

export class IoTSendTool extends BrowserTool {
  get name() { return 'iot_send'; }
  get description() {
    return 'Send a command or payload to an IoT device.';
  }
  get parameters() {
    return {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'Target device ID' },
        payload: { type: 'object', description: 'Data payload to send' },
      },
      required: ['deviceId', 'payload'],
    };
  }
  get permission() { return 'approve'; }

  async execute({ deviceId, payload }) {
    try {
      const bridge = meshToolsContext.getIoTBridge();
      if (!bridge) {
        return { success: false, output: '', error: 'IoT bridge not initialized.' };
      }
      await bridge.send(deviceId, payload);
      return { success: true, output: `Payload sent to device ${deviceId}.` };
    } catch (err) {
      return { success: false, output: '', error: `IoT send failed: ${err.message}` };
    }
  }
}

// ── iot_telemetry ────────────────────────────────────────────────────

export class IoTTelemetryTool extends BrowserTool {
  get name() { return 'iot_telemetry'; }
  get description() {
    return 'Query telemetry data from an IoT device.';
  }
  get parameters() {
    return {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'Device ID to query' },
        since: { type: 'number', description: 'Start timestamp (optional)' },
        until: { type: 'number', description: 'End timestamp (optional)' },
        stats: { type: 'boolean', description: 'Return statistics instead of raw data (default: false)' },
      },
      required: ['deviceId'],
    };
  }
  get permission() { return 'read'; }

  async execute({ deviceId, since, until, stats }) {
    try {
      const telemetry = meshToolsContext.getIoTTelemetry();
      if (!telemetry) {
        return { success: false, output: '', error: 'IoT telemetry not initialized.' };
      }
      if (stats) {
        const s = telemetry.getStats(deviceId);
        if (!s) {
          return { success: true, output: `No telemetry data for device ${deviceId}.` };
        }
        return { success: true, output: `Device ${deviceId} stats: min=${s.min} max=${s.max} avg=${s.avg.toFixed(2)} count=${s.count} last=${s.last}` };
      }
      const samples = telemetry.query(deviceId, since, until);
      if (samples.length === 0) {
        return { success: true, output: `No telemetry data for device ${deviceId}.` };
      }
      return { success: true, output: `${samples.length} samples for ${deviceId}:\n${samples.map(s => `${new Date(s.ts).toISOString()}: ${s.value}`).join('\n')}` };
    } catch (err) {
      return { success: false, output: '', error: `Telemetry query failed: ${err.message}` };
    }
  }
}

// ── Registry helper ──────────────────────────────────────────────────

/**
 * Register all mesh stream/file tools with a BrowserToolRegistry.
 * @param {import('./compat.mjs').BrowserToolRegistry} registry
 * @param {import('@johnhenry/browsermesh-transport').StreamMultiplexer} [multiplexer]
 * @param {import('@johnhenry/browsermesh-sync').MeshFileTransfer} [fileTransfer]
 */
export function registerMeshTools(registry, multiplexer, fileTransfer) {
  if (multiplexer) meshToolsContext.setMultiplexer(multiplexer);
  if (fileTransfer) meshToolsContext.setFileTransfer(fileTransfer);

  registry.register(new MeshStreamOpenTool());
  registry.register(new MeshStreamCloseTool());
  registry.register(new MeshStreamListTool());
  registry.register(new MeshFileSendTool());
  registry.register(new MeshFileAcceptTool());
  registry.register(new MeshFileListTool());
  registry.register(new MeshFileCancelTool());
  registry.register(new DhtStoreTool());
  registry.register(new DhtLookupTool());
  registry.register(new DhtPeersTool());
  registry.register(new GpuTrainStartTool());
  registry.register(new GpuTrainStatusTool());
  registry.register(new IoTListTool());
  registry.register(new IoTSendTool());
  registry.register(new IoTTelemetryTool());
}
