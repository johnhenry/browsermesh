/**
 * wsh-pairing.mjs -- how a host half that waits at a pipe relay tells wsh its far side has not arrived yet.
 *
 * wsh 0.54 closes a connection that has not logged in `loginTimeoutMs` (60 s) after the host accepted it. A host half is accepted
 * when it reaches the relay, long before a peer pairs with it. wsh 0.54.1 takes `host.accept(socket, { waitForPeer })`: the clock then
 * starts when the far side arrives (the relay's paired signal, when the half asked for it with `?paired=1`, or the first byte the far
 * side sends, whichever comes first), so a half that waits is neither refused nor closed and a peer that arrives and stays silent is.
 *
 * `watchPairing` (from `@johnhenry/wsh/pipe-relay`) exists from that same release. With an older wsh it is absent: `loadWatchPairing()`
 * then returns `null` and the caller keeps `loginTimeoutMs: 0` on those hosts (wsh 0.54.0 would otherwise close every waiting half each
 * minute; 0.53 and earlier have no deadline and ignore the option).
 *
 * The specifier is a literal so that a bundler can split it and a browser can resolve it.
 */

let loaded = null;

/**
 * @returns {Promise<((socket: object) => { socket: object, paired: Promise<void> }) | null>}
 *   wsh's `watchPairing`, or null when the installed wsh predates `waitForPeer`.
 */
export function loadWatchPairing() {
  loaded ??= import('@johnhenry/wsh/pipe-relay').then((m) => (typeof m?.watchPairing === 'function' ? m.watchPairing : null), () => null);
  return loaded;
}

/**
 * What to hand `host.accept(socket, options)` for a host half that has just connected to a relay.
 * @param {object} socket the WebSocket-like the half dialled
 * @param {((socket: object) => { socket: object, paired: Promise<void> }) | null} watchPairing from `loadWatchPairing()`
 * @returns {{ socket: object, options: object }} accept the returned socket with the returned options
 */
export function waitingHalf(socket, watchPairing) {
  if (!watchPairing) return { socket, options: {} };
  // Wrapped before anything else is attached, so the host never reads the signal frame. A relay that predates the signal never sends it:
  // `paired` then never settles and wsh starts the clock at the first byte.
  const { socket: watched, paired } = watchPairing(socket);
  return { socket: watched, options: { waitForPeer: paired } };
}
