/**
 * reassembler.mjs -- reconstructs full messages from chunk frames.
 *
 * Buffers chunks by `msgId` until `total` distinct sequence numbers have
 * arrived, then hands back the concatenated bytes in the correct order --
 * regardless of the order chunks actually arrived in (interleaving across
 * concurrent messages, or even out-of-order delivery of one message's own
 * chunks, must both reassemble correctly). A message is never handed back
 * partially: `receive()` returns a result only on the exact frame that
 * completes it.
 */

export class Reassembler {
  #pending = new Map(); // msgId -> { total, priority, chunks: Array<Uint8Array|undefined>, receivedCount }

  /**
   * Feed one decoded chunk frame in. Returns the reassembled message once
   * complete, otherwise `undefined`.
   * @param {{ priority: string, msgId: number, seq: number, total: number, payload: Uint8Array }} frame
   * @returns {{ msgId: number, priority: string, bytes: Uint8Array }|undefined}
   */
  receive({ priority, msgId, seq, total, payload }) {
    if (total < 1) throw new Error('priority-mux: frame has invalid total');
    if (seq < 0 || seq >= total) {
      throw new Error(`priority-mux: chunk seq ${seq} out of range for total ${total}`);
    }

    let entry = this.#pending.get(msgId);
    if (!entry) {
      entry = { total, priority, chunks: new Array(total), receivedCount: 0 };
      this.#pending.set(msgId, entry);
    } else if (entry.total !== total) {
      throw new Error(`priority-mux: msgId ${msgId} total mismatch (${entry.total} vs ${total})`);
    }

    // Duplicate delivery of the same (msgId, seq) is a no-op, not a
    // duplicate-count bump -- keeps `receivedCount` accurate even if a
    // transport ever redelivers.
    if (entry.chunks[seq] === undefined) {
      entry.chunks[seq] = payload;
      entry.receivedCount++;
    }

    if (entry.receivedCount < entry.total) return undefined;

    // Complete -- concatenate in seq order and remove the pending entry so
    // it can never be double-delivered or leak memory.
    this.#pending.delete(msgId);
    let byteLength = 0;
    for (const chunk of entry.chunks) byteLength += chunk.byteLength;
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of entry.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { msgId, priority: entry.priority, bytes };
  }

  /** Number of messages currently mid-reassembly. */
  get pendingCount() {
    return this.#pending.size;
  }

  /**
   * Discard all in-flight reassembly state. Must be called when the
   * underlying transport closes so a partially-received message never
   * hangs around waiting for chunks that will never arrive.
   */
  reset() {
    this.#pending.clear();
  }
}
