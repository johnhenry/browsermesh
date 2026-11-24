/**
 * A hand-written in-memory duplex that satisfies the protocol-channel
 * interface with no mesh code at all: the layer needs only this much.
 * Each end reports the OTHER end as its `peer`, like a real link.
 */
export function memoryChannelPair(peerA = 'mem-a', peerB = 'mem-b') {
  const make = (peer) => {
    const st = { messages: new Set(), closers: new Set(), closed: false, other: null }
    st.channel = {
      peer,
      maxMessageBytes: 1 << 20,
      send: async (obj) => { if (st.closed) throw new Error('closed'); for (const cb of [...st.other.messages]) await cb(structuredClone(obj), { peer }) },
      onMessage: (cb) => { st.messages.add(cb); return () => st.messages.delete(cb) },
      request: async () => { throw new Error('requests are not used by the object layer') },
      notify: async () => { throw new Error('notifications are not used by the object layer') },
      onRequest: () => () => {},
      onNotification: () => () => {},
      onClose: (cb) => { st.closers.add(cb); return () => st.closers.delete(cb) },
      close: () => {
        if (st.closed) return
        st.closed = true
        for (const cb of st.closers) cb(null)
        st.other.channel.close()
      },
    }
    return st
  }
  const a = make(peerA)
  const b = make(peerB)
  a.other = b
  b.other = a
  a.channel.peer = peerB
  b.channel.peer = peerA
  return { a: a.channel, b: b.channel }
}
