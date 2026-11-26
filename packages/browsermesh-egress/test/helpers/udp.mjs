/**
 * Test helpers for UDP: a local datagram origin, and a `dialUdp` behind the provider's seam that uses wsh's real address guard on
 * simulated answers and then connects a REAL datagram socket to a local origin (never to the simulated address).
 */
import dgram from 'node:dgram'
import { AddressGuardError, resolveChecked } from '@johnhenry/wsh/address-guard'
import { rig, PUBLIC } from './mesh.mjs'

export { PUBLIC }

/**
 * A datagram origin on loopback. `onDatagram(message, send, { count })` runs for each datagram (default: echo it).
 * `received` is every payload, in arrival order; `sources` the distinct source ports it heard from.
 */
export async function udpOrigin(onDatagram = (message, send) => send(message)) {
  const socket = dgram.createSocket('udp4')
  const received = []
  const sources = new Set()
  socket.on('error', () => {})
  socket.on('message', (message, rinfo) => {
    received.push(Buffer.from(message))
    sources.add(rinfo.port)
    onDatagram(message, (payload) => socket.send(payload, rinfo.port, rinfo.address, () => {}), { count: received.length, rinfo })
  })
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve))
  return {
    port: socket.address().port,
    received,
    sources,
    /** Send to a source port directly, as a stranger would (the flow's socket must not accept it). */
    sendTo: (payload, port) => socket.send(payload, port, '127.0.0.1', () => {}),
    close() { try { socket.close() } catch { /* closed */ } },
  }
}

/** `dialUdp` for the provider: names and origins as `simNetwork` takes them (`address:port` -> the local UDP port). */
export function simUdp({ names = {}, origins = {}, allowPrivate = [], refuseMixed = true } = {}) {
  const calls = { lookups: [], dials: [] }
  const counts = new Map()
  const lookup = async (name) => {
    calls.lookups.push(name)
    const entry = names[name]
    if (!entry) { const e = new Error('not found'); e.code = 'ENOTFOUND'; throw e }
    if (Array.isArray(entry[0])) { const n = counts.get(name) ?? 0; counts.set(name, n + 1); return entry[Math.min(n, entry.length - 1)] }
    return entry
  }
  return {
    calls,
    async dialUdp({ host, port, wide = false, signal }) {
      calls.dials.push({ host, port, wide })
      const [chosen] = await resolveChecked(host, { allow: wide ? [] : allowPrivate, allowPrivate: false, refuseMixed, lookup, family: 4, signal })
      const local = origins[`${chosen.address}:${port}`]
      if (!local) throw new AddressGuardError('CONNECTION_REFUSED', 'nothing listens there')
      const socket = dgram.createSocket('udp4')
      await new Promise((resolve, reject) => { socket.once('error', reject); socket.connect(local, '127.0.0.1', () => { socket.off('error', reject); resolve() }) })
      return { socket, address: chosen.address, family: chosen.family, class: chosen.class }
    },
  }
}

/** The rig of the other forms with a UDP origin at `game.test:4000` (the simulated public address) and a `dialUdp` onto it. */
export async function udpRig(cleanups, { onDatagram, names, origins, grants = [], egress = {}, link = {}, simOptions = {}, port = 4000 } = {}) {
  const origin = await udpOrigin(onDatagram)
  cleanups.push(() => origin.close())
  const sim = simUdp({ names: names ?? { 'game.test': [PUBLIC] }, origins: origins ?? { [`${PUBLIC}:${port}`]: origin.port }, ...simOptions })
  const out = await rig(cleanups, { grants, link, egress: (pods) => ({ dialUdp: sim.dialUdp, ...(typeof egress === 'function' ? egress(pods) : egress) }) })
  return { ...out, udpOrigin: origin, sim }
}
