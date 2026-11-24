// browsermesh-transport — the main entry as the `node` export condition resolves it, for ONE release.
//
// Up to 0.10 the main entry re-exported the wsh modules (`WshPeerLinks`, `WshServices`, `WshRelay`,
// `WshPodTransport`, ...). They now live at `@johnhenry/browsermesh-transport/wsh`, and the main entry
// (`./index.mjs`) no longer reaches them, so a browser build needs no wsh. To keep a Node program that still
// imports those names from the package root working, the `node` condition of `exports["."]` points here: the
// main entry plus the wsh subpath. Anything that does not resolve the `node` condition (a bundler for the
// browser, an import map, a vendored copy of `src/`) gets `./index.mjs` and must import the names from `/wsh`.
//
// Removed in the next minor: move these imports to `@johnhenry/browsermesh-transport/wsh`.
export * from './index.mjs';
export * from './wsh.mjs';
