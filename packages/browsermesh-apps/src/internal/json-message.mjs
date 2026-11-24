/**
 * Read one JSON message from a netway `StreamSocket`.
 *
 * A socket is a byte stream: a socket with a receive window hands a write
 * larger than that window to its reader in window-sized pieces, so one JSON
 * message may arrive as several `read()` results. The request/response
 * protocols in this package send one JSON document per write, so the reader
 * puts the pieces back together: after a piece that fills the whole window
 * (the only kind that can be followed by more of the same message) it reads
 * on and parses the concatenation. A shorter piece, or a socket with no
 * window, ends the message.
 *
 * @param {{ read(): Promise<Uint8Array|null>, windowBytes?: number }} socket
 * @returns {Promise<{ eof: true } | { eof: false, text: string, value?: any, error?: Error }>}
 *   `eof` when the peer closed before sending anything; otherwise the decoded
 *   text and either the parsed `value` or the parse `error`.
 */
export async function readJsonMessage(socket) {
  const first = await socket.read()
  if (first === null) return { eof: true }
  const window = socket.windowBytes ?? 0
  const parts = [first]
  let last = first
  while (true) {
    const bytes = parts.length === 1 ? first : concat(parts)
    const text = new TextDecoder().decode(bytes)
    try {
      return { eof: false, text, value: JSON.parse(text) }
    } catch (error) {
      if (!(window > 0 && last.length >= window)) return { eof: false, text, error }
    }
    const next = await socket.read()
    if (next === null) {
      const text2 = new TextDecoder().decode(concat(parts))
      return { eof: false, text: text2, error: new Error('socket closed in the middle of a message') }
    }
    parts.push(next)
    last = next
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
