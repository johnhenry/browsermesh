/**
 * @johnhenry/browsermesh-egress/browser: a page's whole side of reaching an egress provider, in one small import.
 * The consumer half only: no provider, no `node:` import, no wsh.
 */
import type { ConnectEgressOptions, EgressLink } from './index.js'

export {
  connectEgress, EgressError, EgressBackend, REFUSAL_CODES, BUDGET_NAMES, END_REASONS, LINK_CODES, CLOSE_REASONS,
  CONSUMER_LIMIT_DEFAULTS, KEEPALIVE_DEFAULTS, createAddressMemory, EGRESS_SCOPES, EGRESS_PROTOCOL, EGRESS_VERSIONS,
} from './index.js'
export type {
  ConnectEgressOptions, EgressLink, EgressUdpFlow, KeepAliveOptions, CloseReason, LinkCode, RefusalCode, EndReason, BudgetName, ConsumerLimits,
} from './index.js'

/** A signalling transport: what the node sends WebRTC offers, answers and ICE through. */
export interface SignalingTransport {
  send(message: object): void
  onMessage(cb: (message: any) => void): void
  open?(): Promise<void>
  close?(): Promise<void> | void
}

export interface EgressNodeOptions {
  /** The signalling server's WebSocket URL (`ws://` or `wss://`), or a ready transport. */
  signaling: string | SignalingTransport
  /** An identity to restore (the key `identityManager.export(podId)` gave); a new one when absent. */
  identity?: { privateKeyJwk: object; label?: string }
  label?: string
  /** Merged with the defaults (none); `[]` means none at all. Add TURN servers here for a provider behind a strict NAT. */
  iceServers?: Array<{ urls: string | string[]; username?: string; credential?: string }>
  /** How long `connect` waits for the provider to answer through the signalling server (default 15000). */
  answerTimeoutMs?: number
  /** How long `connect` waits for the data channel to open once the provider answered (default 15000). */
  openTimeoutMs?: number
  onLog?: (event: string, data?: object) => void
}

export interface EgressNode {
  /** This page's pod id: what the provider's operator grants `protocol:egress:open` and the destinations to. */
  readonly podId: string
  readonly service: { api: { openProtocol(peer: string, name: string, options?: object): Promise<object> }; teardown?(): void }
  readonly registry: object
  readonly node: object
  readonly identityManager: { export(podId: string): Promise<object> }
  /**
   * Connect to the provider's pod (a live session is reused), then open protocol `egress` on it and return the link. Rejects with an
   * `EgressError`: `signalling-unreachable`, `provider-not-found`, `provider-timeout`, `provider-not-authorized`, `provider-no-egress`,
   * `provider-version`, `provider-refused`, ...
   */
  connect(providerPodId: string, options?: ConnectEgressOptions): Promise<EgressLink>
  /** Close the node: the signalling connection and every link with it. */
  close(): Promise<void>
}

export function createEgressNode(options: EgressNodeOptions): Promise<EgressNode>
