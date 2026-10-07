/**
 * Inbound half of the mesh wire-envelope contract.
 *
 * A real transport (`RTCDataChannel`, `WebSocket`) can only carry strings and
 * binary, so a MeshService envelope (`{ type, ...payload }`) crosses it as
 * JSON text -- see `@johnhenry/browsermesh-transport`'s `encodeWireData()`
 * for the outbound half. Some transports parse that text back before they
 * hand it up (`WebRTCPeerConnection` does); others hand `PeerNode` the raw
 * string. A consumer that wants envelope objects therefore has to accept
 * both, which is what this does.
 *
 * Only strings that look like a JSON object or array are parsed, so a plain
 * text payload that merely happens to be valid JSON (`"42"`, `"true"`) is
 * left exactly as the sender wrote it. A string that looks like JSON but
 * does not parse is returned unchanged rather than thrown on -- one corrupt
 * frame must never take down the shared dispatch loop.
 *
 * Browser-safe: no imports.
 *
 * @param {*} data - Whatever `PeerNode.onIncomingData()` delivered.
 * @returns {*} The parsed object/array when `data` was a JSON object/array
 *   string; `data` itself otherwise.
 */
export function decodeWireData(data) {
  if (typeof data !== 'string') return data
  const first = data.trimStart()[0]
  if (first !== '{' && first !== '[') return data
  try {
    return JSON.parse(data)
  } catch {
    return data
  }
}
