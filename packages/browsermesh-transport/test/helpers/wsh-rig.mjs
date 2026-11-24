// Shared fixtures for the wsh link tests: an in-process pipe relay that can
// record and tamper with every byte it copies, and a few pod/hub builders.
import { PodIdentity } from '@johnhenry/browsermesh-primitives';
import { WshPeerLinks } from '../../src/wsh.mjs';
// wsh's own in-process relay (0.49 and later). The published `wsh-in-process` subpath is the same double for older wsh, so the
// tests can also be run against the oldest wsh this package claims (0.45): that is the only reason the fallback exists.
const { createInProcessPipeRelay } = await import('@johnhenry/wsh/testing')
  .then((m) => (typeof m.createInProcessPipeRelay === 'function' ? m : import('../../src/wsh-in-process.mjs')))
  .catch(() => import('../../src/wsh-in-process.mjs'));

export const RELAY = 'wss://relay.invalid';

export async function makeEnv(opts) {
  return createInProcessPipeRelay(opts);
}

/** Identities first, so authorize callbacks can name each other. */
export async function makeIdentities(n) {
  return Promise.all(Array.from({ length: n }, () => PodIdentity.generate()));
}

/**
 * A hub for `identity` on `env`. `allow` is a list of pod ids (or a function) the
 * hub's authorize callback will accept; default is nobody.
 */
export function makeHub(env, identity, { allow = [], ...rest } = {}) {
  const calls = [];
  const authorize = typeof allow === 'function'
    ? allow
    : (peer) => allow.includes(peer.podId);
  const hub = new WshPeerLinks({
    identity,
    relays: [RELAY],
    WebSocket: env.WebSocket,
    authorize: (peer) => { calls.push(peer.podId); return authorize(peer); },
    connectTimeoutMs: 4000,
    reconnect: { baseMs: 5, maxMs: 25 },
    ...rest,
  });
  hub.authorizeCalls = calls;
  hub.events = [];
  for (const ev of ['peer-up', 'peer-down', 'message', 'refused', 'error', 'dropped']) {
    hub.on(ev, (e) => hub.events.push({ ev, ...e }));
  }
  hub.of = (ev) => hub.events.filter((e) => e.ev === ev);
  return hub;
}

export function bytesContain(haystack, needle) {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

export function concatRecorded(env) {
  const total = env.recorded.reduce((n, r) => n + r.bytes.length, 0);
  const all = new Uint8Array(total);
  let o = 0;
  for (const r of env.recorded) { all.set(r.bytes, o); o += r.bytes.length; }
  return all;
}
