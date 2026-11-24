/**
 * FsServiceBackend — svc://fs backend wrapping OPFS as a service.
 *
 * Provides ByteStream access to local OPFS file operations via the
 * service mesh. Agents use `svc://fs` transparently alongside other services.
 *
 * @module fs-service-backend
 */

import { Backend } from './backend.mjs';
import { StreamSocket } from './stream-socket.mjs';
import { ConnectionRefusedError } from './errors.mjs';

/** Largest command message reassembled by default: 64 windows of the default 256 KiB. */
export const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

/**
 * Read one JSON command from a socket. A write larger than the socket's
 * receive window reaches the reader in window-sized pieces. A shorter piece
 * (or a socket with no window) ends the message; after a piece that fills the
 * whole window this reads on, and parses only once a scan of the bytes already
 * held says the document is balanced (each byte is scanned once, so a long
 * message costs one parse, not one per piece). A message that does not start
 * with `{` or `[` cannot be scanned and is parsed after each full piece.
 *
 * More than `maxBytes` without a complete message is refused (`tooLarge`),
 * holding at most `maxBytes` plus one window. The wire format is unchanged.
 *
 * @param {StreamSocket} socket
 * @param {number} [maxBytes]
 * @returns {Promise<{eof: true}|{eof: false, value?: any, error?: Error, tooLarge?: true}>}
 */
async function readJsonMessage(socket, maxBytes = DEFAULT_MAX_MESSAGE_BYTES) {
  const first = await socket.read();
  if (first === null) return { eof: true };
  const window = socket.windowBytes ?? 0;
  const tooLarge = () => ({ eof: false, tooLarge: true, error: new Error(`message is larger than ${maxBytes} bytes`) });
  let total = first.length;
  if (total > maxBytes) return tooLarge();
  const parts = [first];
  let last = first;
  // Incremental scan: has the document opened a container, and is every container closed?
  let started = false;
  let container = false;
  let balanced = false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  const scan = (bytes) => {
    for (let i = 0; i < bytes.length; i += 1) {
      const c = bytes[i];
      if (!started) {
        if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) continue;
        started = true;
        if (c !== 0x7b && c !== 0x5b) return;
        container = true;
      }
      if (!container) return;
      if (inString) {
        if (escaped) escaped = false;
        else if (c === 0x5c) escaped = true;
        else if (c === 0x22) inString = false;
        continue;
      }
      if (c === 0x22) inString = true;
      else if (c === 0x7b || c === 0x5b) depth += 1;
      else if (c === 0x7d || c === 0x5d) depth -= 1;
      balanced = depth === 0;
    }
  };
  scan(first);
  while (true) {
    const mayContinue = window > 0 && last.length >= window;
    // Balanced container, or (unscannable) anything else after a full piece: worth a parse.
    if (!mayContinue || (container ? balanced : started)) {
      let bytes = first;
      if (parts.length > 1) {
        bytes = new Uint8Array(total);
        let off = 0;
        for (const p of parts) { bytes.set(p, off); off += p.length; }
      }
      try {
        return { eof: false, value: JSON.parse(new TextDecoder().decode(bytes)) };
      } catch (error) {
        // A balanced document that does not parse cannot be mended by more bytes.
        if (!mayContinue || container) return { eof: false, error };
      }
    }
    const next = await socket.read();
    if (next === null) return { eof: false, error: new Error('socket closed in the middle of a message') };
    total += next.length;
    if (total > maxBytes) return tooLarge();
    parts.push(next);
    scan(next);
    last = next;
  }
}

/**
 * Backend that provides OPFS file access as a service.
 * When connected, returns a socket pair where the server side handles
 * file operation messages.
 */
export class FsServiceBackend extends Backend {
  #opfsRoot;
  #maxMessageBytes;

  /**
   * @param {FileSystemDirectoryHandle} [opfsRoot] - OPFS root directory handle.
   *   If not provided, connect() will attempt to get it via navigator.storage.getDirectory().
   * @param {object} [opts]
   * @param {number} [opts.maxMessageBytes=16777216] - Largest command message
   *   reassembled from window-sized pieces; a longer one is answered with an
   *   error and the connection is closed.
   */
  constructor(opfsRoot, { maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES } = {}) {
    super();
    this.#opfsRoot = opfsRoot || null;
    this.#maxMessageBytes = maxMessageBytes;
  }

  /**
   * Connect to the filesystem service. Returns a StreamSocket whose peer
   * can receive file operation commands.
   *
   * @param {string} host - Service path (e.g. 'fs' for svc://fs).
   * @param {number} [port] - Ignored.
   * @returns {Promise<StreamSocket>}
   */
  async connect(host, port) {
    if (!this.#opfsRoot) {
      try {
        this.#opfsRoot = await navigator.storage.getDirectory();
      } catch {
        throw new ConnectionRefusedError(`svc://${host}`);
      }
    }

    const [clientSocket, serverSocket] = StreamSocket.createPair();

    // Start the server-side handler asynchronously
    this.#handleConnection(serverSocket).catch(() => {
      serverSocket.close().catch(() => {});
    });

    return clientSocket;
  }

  async #handleConnection(socket) {
    const encoder = new TextEncoder();

    while (true) {
      const msg = await readJsonMessage(socket, this.#maxMessageBytes);
      if (msg.eof) break;

      if (msg.tooLarge) {
        // The stream is mid-message: answer once and close rather than read the rest as commands.
        await socket.write(encoder.encode(JSON.stringify({ error: msg.error.message }))).catch(() => {});
        await socket.close().catch(() => {});
        break;
      }

      if (msg.error) {
        await socket.write(encoder.encode(JSON.stringify({ error: 'Invalid JSON' })));
        continue;
      }
      const cmd = msg.value;

      try {
        let result;
        switch (cmd.op) {
          case 'list': {
            const dir = cmd.path ? await this.#resolvePath(cmd.path) : this.#opfsRoot;
            const entries = [];
            for await (const [name, handle] of dir.entries()) {
              entries.push({ name, kind: handle.kind });
            }
            result = { entries };
            break;
          }
          case 'read': {
            const file = await this.#resolveFile(cmd.path);
            const blob = await file.getFile();
            const data = new Uint8Array(await blob.arrayBuffer());
            // Send as base64 for JSON transport
            result = { data: btoa(String.fromCharCode(...data)), size: data.length };
            break;
          }
          case 'write': {
            const parts = cmd.path.split('/');
            const fileName = parts.pop();
            const dir = parts.length > 0
              ? await this.#resolvePath(parts.join('/'))
              : this.#opfsRoot;
            const file = await dir.getFileHandle(fileName, { create: true });
            const writable = await file.createWritable();
            const data = Uint8Array.from(atob(cmd.data), c => c.charCodeAt(0));
            await writable.write(data);
            await writable.close();
            result = { written: data.length };
            break;
          }
          case 'delete': {
            const parts = cmd.path.split('/');
            const name = parts.pop();
            const dir = parts.length > 0
              ? await this.#resolvePath(parts.join('/'))
              : this.#opfsRoot;
            await dir.removeEntry(name, { recursive: cmd.recursive || false });
            result = { deleted: true };
            break;
          }
          default:
            result = { error: `Unknown op: ${cmd.op}` };
        }
        await socket.write(encoder.encode(JSON.stringify(result)));
      } catch (err) {
        await socket.write(encoder.encode(JSON.stringify({ error: err.message })));
      }
    }
  }

  async #resolvePath(path) {
    const parts = path.split('/').filter(Boolean);
    let dir = this.#opfsRoot;
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, { create: false });
    }
    return dir;
  }

  async #resolveFile(path) {
    const parts = path.split('/').filter(Boolean);
    const fileName = parts.pop();
    let dir = this.#opfsRoot;
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, { create: false });
    }
    return dir.getFileHandle(fileName, { create: false });
  }
}
