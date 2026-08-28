// Polyfill browser globals for Node.js test environment.
// Use with: node --import ./test/_setup-globals.mjs --test test/*.test.mjs
//
// Vendored from clawser's web/test/_setup-globals.mjs (fully generic, no
// clawser-app coupling) so this package's tests are self-contained.

const store = {};
globalThis.localStorage = {
  getItem: (k) => store[k] ?? null,
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
  clear: () => { for (const k of Object.keys(store)) delete store[k]; },
};

globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, addEventListener() {}, appendChild() {} }),
  addEventListener: () => {},
};

globalThis.location = { search: '', hash: '', href: '' };
globalThis.history = { replaceState() {} };
try {
  globalThis.navigator = { storage: { getDirectory: async () => ({}) }, locks: { request: async (_name, optsOrCb, maybeCb) => { const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb; if (cb) return cb({ name: _name }) } } };
} catch {
  // navigator is a getter in Node — patch individual properties instead
  if (globalThis.navigator) {
    if (!globalThis.navigator.storage) {
      Object.defineProperty(globalThis.navigator, 'storage', {
        value: { getDirectory: async () => ({}) },
        configurable: true,
      });
    }
    if (!globalThis.navigator.locks) {
      Object.defineProperty(globalThis.navigator, 'locks', {
        value: { request: async (_name, optsOrCb, maybeCb) => { const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb; if (cb) return cb({ name: _name }) } },
        configurable: true,
      });
    }
  }
}
globalThis.BroadcastChannel = class { postMessage() {} close() {} onmessage() {} };
globalThis.URL = globalThis.URL || URL;
globalThis.TextEncoder = globalThis.TextEncoder || TextEncoder;
globalThis.TextDecoder = globalThis.TextDecoder || TextDecoder;
