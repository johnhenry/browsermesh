/**
 * Read one JSON message from a netway `StreamSocket`.
 *
 * A socket is a byte stream: a socket with a receive window hands a write
 * larger than that window to its reader in window-sized pieces, so one JSON
 * message may arrive as several `read()` results. The request/response
 * protocols in this package send one JSON document per write, so the reader
 * puts the pieces back together. A piece shorter than the window, or a socket
 * with no window, ends the message. After a piece that fills the whole window
 * (the only kind that can be followed by more of the same message) the reader
 * keeps reading, and parses only when a scan of the bytes it already holds
 * says the document is balanced (every `{`/`[` closed, outside strings): each
 * byte is scanned once, so a long message costs one parse, not one per piece.
 * A message that does not start with `{` or `[` cannot be scanned and is
 * parsed after each full piece.
 *
 * The message is bounded: once more than `maxBytes` have arrived without the
 * message being complete the reader gives up (`tooLarge`), holding at most
 * `maxBytes` plus one window. The wire format is unchanged, so an older peer
 * is served exactly as before.
 *
 * @param {{ read(): Promise<Uint8Array|null>, windowBytes?: number }} socket
 * @param {{ maxBytes?: number }} [opts]
 * @returns {Promise<{ eof: true } | { eof: false, text: string, value?: any, error?: Error, tooLarge?: true, stats: {bytes: number, pieces: number, parseAttempts: number} }>}
 *   `eof` when the peer closed before sending anything; otherwise the decoded
 *   text and either the parsed `value` or the `error`. `tooLarge` marks a
 *   refusal for size: the stream is then in the middle of a message and the
 *   caller should close the socket. `stats` are the reader's own counters.
 */
export async function readJsonMessage(socket, { maxBytes = DEFAULT_MAX_MESSAGE_BYTES } = {}) {
  const first = await socket.read()
  if (first === null) return { eof: true }
  const window = socket.windowBytes ?? 0
  const stats = { bytes: first.length, pieces: 1, parseAttempts: 0 }
  if (stats.bytes > maxBytes) return tooLarge(maxBytes, stats)
  const parts = [first]
  let last = first
  const scan = new DocumentScan()
  scan.feed(first)
  while (true) {
    const mayContinue = window > 0 && last.length >= window
    // Balanced container, or (unscannable) anything else after a full piece: worth a parse.
    if (!mayContinue || (scan.container ? scan.balanced : scan.started)) {
      const text = new TextDecoder().decode(parts.length === 1 ? first : concat(parts))
      stats.parseAttempts += 1
      try {
        return { eof: false, text, value: JSON.parse(text), stats }
      } catch (error) {
        // A balanced document that does not parse cannot be mended by more bytes.
        if (!mayContinue || scan.container) return { eof: false, text, error, stats }
      }
    }
    const next = await socket.read()
    if (next === null) {
      const text = new TextDecoder().decode(concat(parts))
      return { eof: false, text, error: new Error('socket closed in the middle of a message'), stats }
    }
    stats.bytes += next.length
    stats.pieces += 1
    if (stats.bytes > maxBytes) return tooLarge(maxBytes, stats)
    parts.push(next)
    scan.feed(next)
    last = next
  }
}

/** Largest message `readJsonMessage` reassembles by default: 64 windows of the default 256 KiB. */
export const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024

/** @param {number} maxBytes @param {object} stats */
function tooLarge(maxBytes, stats) {
  return {
    eof: false,
    text: '',
    tooLarge: true,
    error: new Error(`message is larger than ${maxBytes} bytes`),
    stats,
  }
}

/**
 * Incremental scan of a JSON document's bytes: whether it opened a container
 * and every container is closed again. Strings (with escapes) are skipped; the
 * bytes it looks at are ASCII, which UTF-8 never uses inside a multi-byte
 * sequence.
 */
class DocumentScan {
  container = false
  balanced = false
  started = false
  #depth = 0
  #inString = false
  #escaped = false

  /** @param {Uint8Array} bytes */
  feed(bytes) {
    for (let i = 0; i < bytes.length; i += 1) {
      const c = bytes[i]
      if (!this.started) {
        if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) continue
        this.started = true
        if (c !== 0x7b && c !== 0x5b) return
        this.container = true
      }
      if (!this.container) return
      if (this.#inString) {
        if (this.#escaped) this.#escaped = false
        else if (c === 0x5c) this.#escaped = true
        else if (c === 0x22) this.#inString = false
        continue
      }
      if (c === 0x22) this.#inString = true
      else if (c === 0x7b || c === 0x5b) this.#depth += 1
      else if (c === 0x7d || c === 0x5d) this.#depth -= 1
      this.balanced = this.#depth === 0
    }
  }
}

function concat(parts) {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let off = 0
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}
