// browsermesh-apps — Applications layer
export * from './apps.mjs';
export * from './marketplace.mjs';
export * from './chat.mjs';
export * from './payments.mjs';
export * from './quotas.mjs';
export * from './resources.mjs';
export * from './gpu.mjs';
export * from './scheduler.mjs';
export * from './consensus.mjs';
export * from './orchestrator.mjs';
export * from './audit.mjs';
export * from './visualizations.mjs';
export * from './devtools.mjs';
export * from './tools.mjs';
export * from './peer-agent.mjs';
export * from './peer-agent-swarm.mjs';
export * from './peer-chat.mjs';
export * from './peer-compute.mjs';
export * from './peer-encrypted-store.mjs';
export * from './peer-escrow.mjs';
export * from './peer-files.mjs';
export * from './peer-health.mjs';
export * from './peer-ipfs.mjs';
export * from './peer-node.mjs';
export * from './peer-payments.mjs';
export * from './peer-registry.mjs';
export * from './peer-routing.mjs';
export * from './peer-services.mjs';
export * from './peer-session.mjs';
export * from './peer-terminal.mjs';
export * from './peer-timestamp.mjs';
export * from './peer-torrent.mjs';
export * from './peer-verification.mjs';
export * from './marketplace-ui.mjs';
export { BrowserTool } from './compat.mjs';

// `CreditLedger` is defined in both payments.mjs and peer-payments.mjs;
// `EscrowManager` is defined in both payments.mjs and peer-escrow.mjs.
// Ambiguous `export *` bindings are silently dropped, so disambiguate
// explicitly in favor of the pair actually used together (mesh-level
// payments.mjs's CreditLedger + peer-escrow.mjs's opts-based EscrowManager).
export { CreditLedger } from './payments.mjs';
export { EscrowManager } from './peer-escrow.mjs';
