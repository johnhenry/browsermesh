// Type definitions for @johnhenry/browsermesh-pod

import type { PodIdentity } from "@johnhenry/browsermesh-primitives";

// ── Pod kind & capability detection ─────────────────────────────────────────

export type PodKind =
  | "service-worker"
  | "shared-worker"
  | "worker"
  | "worklet"
  | "server"
  | "iframe"
  | "spawned"
  | "window";

export declare function detectPodKind(g?: object): PodKind;

export interface PodCapabilities {
  messaging: {
    postMessage: boolean;
    messageChannel: boolean;
    broadcastChannel: boolean;
    sharedWorker: boolean;
    serviceWorker: boolean;
  };
  network: {
    fetch: boolean;
    webSocket: boolean;
    webTransport: boolean;
    webRTC: boolean;
  };
  storage: {
    indexedDB: boolean;
    cacheAPI: boolean;
    opfs: boolean;
  };
  compute: {
    wasm: boolean;
    sharedArrayBuffer: boolean;
    offscreenCanvas: boolean;
  };
}

export declare function detectCapabilities(g?: object): PodCapabilities;

// ── Wire protocol messages ───────────────────────────────────────────────────

export declare const POD_HELLO: "pod:hello";
export declare const POD_HELLO_ACK: "pod:hello-ack";
export declare const POD_GOODBYE: "pod:goodbye";
export declare const POD_MESSAGE: "pod:message";
export declare const POD_RPC_REQUEST: "pod:rpc-request";
export declare const POD_RPC_RESPONSE: "pod:rpc-response";

export interface PodHelloMessage {
  type: typeof POD_HELLO;
  podId: string;
  kind: string;
  capabilities: PodCapabilities | null;
  ts: number;
}

export interface PodHelloAckMessage {
  type: typeof POD_HELLO_ACK;
  podId: string;
  kind: string;
  targetPodId: string;
  ts: number;
}

export interface PodGoodbyeMessage {
  type: typeof POD_GOODBYE;
  podId: string;
  ts: number;
}

export interface PodMessage {
  type: typeof POD_MESSAGE;
  from: string;
  to: string;
  payload: unknown;
  ts: number;
}

export interface PodRpcRequestMessage {
  type: typeof POD_RPC_REQUEST;
  from: string;
  to: string;
  method: string;
  params: unknown;
  requestId: string;
  ts: number;
}

export interface PodRpcResponseMessage {
  type: typeof POD_RPC_RESPONSE;
  from: string;
  to: string;
  requestId: string;
  result: unknown;
  error: string | null;
  ts: number;
}

export declare function createHello(opts: {
  podId: string;
  kind: string;
  capabilities?: PodCapabilities | null;
}): PodHelloMessage;

export declare function createHelloAck(opts: {
  podId: string;
  kind: string;
  targetPodId: string;
}): PodHelloAckMessage;

export declare function createGoodbye(opts: { podId: string }): PodGoodbyeMessage;

export declare function createMessage(opts: {
  from: string;
  to: string;
  payload?: unknown;
}): PodMessage;

export declare function createRpcRequest(opts: {
  from: string;
  to: string;
  method: string;
  params?: unknown;
  requestId: string;
}): PodRpcRequestMessage;

export declare function createRpcResponse(opts: {
  from: string;
  to: string;
  requestId: string;
  result?: unknown;
  error?: string;
}): PodRpcResponseMessage;

// ── Transport adapters ───────────────────────────────────────────────────────

export interface TransportAdapter {
  readonly ready: boolean;
  onMessage(handler: (msg: any) => void): void;
  open(): Promise<void>;
  send(msg: any): void;
  close(): Promise<void>;
}

export declare class BroadcastChannelTransport implements TransportAdapter {
  constructor(channelName: string, BCConstructor?: new (name: string) => any);
  get ready(): boolean;
  onMessage(handler: (msg: any) => void): void;
  open(): Promise<void>;
  send(msg: any): void;
  close(): Promise<void>;
}

export declare class EventEmitterTransport implements TransportAdapter {
  constructor(bus?: Set<(msg: any, sender: EventEmitterTransport) => void>);
  static createBus(): Set<(msg: any, sender: EventEmitterTransport) => void>;
  get ready(): boolean;
  get bus(): Set<(msg: any, sender: EventEmitterTransport) => void>;
  onMessage(handler: (msg: any) => void): void;
  open(): Promise<void>;
  send(msg: any): void;
  close(): Promise<void>;
}

export declare class NullTransport implements TransportAdapter {
  get ready(): boolean;
  onMessage(handler: (msg: any) => void): void;
  open(): Promise<void>;
  send(msg: any): void;
  close(): Promise<void>;
}

// ── Discovery adapters ────────────────────────────────────────────────────────

export interface PeerFoundInfo {
  podId: string;
  kind?: string;
}

export interface PeerLostInfo {
  podId: string;
}

export interface DiscoveryAdapter {
  onPeerDiscovered(handler: (info: PeerFoundInfo) => void): void;
  onPeerLost(handler: (info: PeerLostInfo) => void): void;
  onMessage(handler: (msg: any) => void): void;
  start(): Promise<void>;
  stop(opts?: { silent?: boolean }): Promise<void>;
}

export declare class TransportDiscovery implements DiscoveryAdapter {
  constructor(opts: {
    transport: TransportAdapter;
    localPodId: string;
    localKind: string;
    capabilities?: PodCapabilities | null;
    timeout?: number;
  });
  onPeerDiscovered(handler: (info: PeerFoundInfo) => void): void;
  onPeerLost(handler: (info: PeerLostInfo) => void): void;
  onMessage(handler: (msg: any) => void): void;
  start(): Promise<void>;
  stop(opts?: { silent?: boolean }): Promise<void>;
}

export declare class NullDiscovery implements DiscoveryAdapter {
  onPeerDiscovered(handler: (info: PeerFoundInfo) => void): void;
  onPeerLost(handler: (info: PeerLostInfo) => void): void;
  onMessage(handler: (msg: any) => void): void;
  start(): Promise<void>;
  stop(opts?: { silent?: boolean }): Promise<void>;
}

// ── Pod ────────────────────────────────────────────────────────────────────

export type PodState = "idle" | "booting" | "ready" | "shutdown";
export type PodRole = "autonomous" | "child" | "peer" | "controlled" | "hybrid";

export interface PeerInfo {
  podId: string;
  kind?: string;
  role?: string;
  lastSeen: number;
}

export interface PodBootOptions {
  identity?: PodIdentity | { podId: string };
  transport?: TransportAdapter;
  discovery?: DiscoveryAdapter;
  discoveryChannel?: string;
  handshakeTimeout?: number;
  discoveryTimeout?: number;
  globalThis?: typeof globalThis;
}

export interface PodShutdownOptions {
  silent?: boolean;
}

export interface PodJSON {
  podId: string | null;
  kind: PodKind | null;
  role: PodRole;
  state: PodState;
  capabilities: PodCapabilities | null;
  peerCount: number;
  peers: string[];
}

export declare class Pod {
  constructor();

  get podId(): string | null;
  get identity(): PodIdentity | null;
  get capabilities(): PodCapabilities | null;
  get kind(): PodKind | null;
  get role(): PodRole;
  get state(): PodState;
  get peers(): Map<string, PeerInfo>;
  get transport(): BroadcastChannelTransport | EventEmitterTransport | NullTransport | null;

  boot(opts?: PodBootOptions): Promise<void>;
  shutdown(opts?: PodShutdownOptions): Promise<void>;
  send(targetPodId: string, payload: unknown): void;
  broadcast(payload: unknown): void;
  on(event: string, cb: (data: any) => void): void;
  off(event: string, cb: (data: any) => void): void;
  toJSON(): PodJSON;

  protected _onInstallListeners(g: object): void;
  protected _onReady(): void;
  protected _onMessage(msg: any): void;
  protected _emit(event: string, data: any): void;
}

export interface InjectedPodOptions {
  extensionBridge?: { postMessage: (msg: any) => void } | null;
}

export interface PageContext {
  url: string;
  title: string;
  origin: string;
  favicon: string;
}

export interface StructuredPageData {
  title: string;
  url: string;
  meta: Record<string, string>;
  headings: Array<{ tag: string; text: string }>;
}

export declare class InjectedPod extends Pod {
  constructor(opts?: InjectedPodOptions);
  get pageContext(): PageContext | null;
  extractText(): string;
  extractStructured(): StructuredPageData | Record<string, never>;
  showOverlay(): void;
  hideOverlay(): void;
  emit(event: string, data: any): void;
  shutdown(opts?: PodShutdownOptions): Promise<void>;
}

// ── Runtime entrypoints ───────────────────────────────────────────────────────

export interface RuntimeOptions {
  context?: typeof globalThis;
  identity?: PodIdentity;
  discoveryTimeout?: number;
  handshakeTimeout?: number;
  [key: string]: unknown;
}

export declare function installPodRuntime(opts?: RuntimeOptions): Promise<Pod>;
export declare const createRuntime: typeof installPodRuntime;
export declare function createClient(opts?: RuntimeOptions): Promise<Pod>;
export declare function createServer(opts?: RuntimeOptions): Promise<Pod>;
