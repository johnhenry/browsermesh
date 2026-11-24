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

/**
 * Read one JSON command from a socket. A write larger than the socket's
 * receive window reaches the reader in window-sized pieces, so after a piece
 * that fills the whole window this reads on and parses the concatenation; a
 * shorter piece (or a socket with no window) ends the message.
 *
 * @param {StreamSocket} socket
 * @returns {Promise<{eof: true}|{eof: false, value?: any, error?: Error}>}
 */
async function readJsonMessage(socket) {
  const first = await socket.read();
  if (first === null) return { eof: true };
  const window = socket.windowBytes ?? 0;
  const parts = [first];
  let last = first;
  while (true) {
    let bytes = first;
    if (parts.length > 1) {
      bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let off = 0;
      for (const p of parts) { bytes.set(p, off); off += p.length; }
    }
    try {
      return { eof: false, value: JSON.parse(new TextDecoder().decode(bytes)) };
    } catch (error) {
      if (!(window > 0 && last.length >= window)) return { eof: false, error };
    }
    const next = await socket.read();
    if (next === null) return { eof: false, error: new Error('socket closed in the middle of a message') };
    parts.push(next);
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

  /**
   * @param {FileSystemDirectoryHandle} [opfsRoot] - OPFS root directory handle.
   *   If not provided, connect() will attempt to get it via navigator.storage.getDirectory().
   */
  constructor(opfsRoot) {
    super();
    this.#opfsRoot = opfsRoot || null;
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
      const msg = await readJsonMessage(socket);
      if (msg.eof) break;

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
