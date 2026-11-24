/** A protocol service: the api of `attachService(node, undefined, createMeshProtocolService())`. */
export interface McpProtocolService {
  serveProtocol(name: string, handler: (channel: any, info: { peer: string; version: number }) => void, options?: { versions?: number[] }): () => void
  openProtocol(peer: string, name: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<any>
  rootAuthorizer?(protocol: string, options?: { actions?: string[] }): { can(peer: string, root: string, action: string): boolean }
}

export const MCP_PROTOCOL: 'mcp'
export const MCP_ACTIONS: readonly ['list', 'call']
export const TOOL_SCOPE_NAME: RegExp

export const mcpScopes: Readonly<{
  /** `['protocol:mcp:open']` */
  open(protocol?: string): string[]
  /** `mcp:<tool>:list` and `mcp:<tool>:call` (or the actions given). Throws on a name that cannot sit in a scope. */
  tool(name: string, actions?: readonly ('list' | 'call')[], protocol?: string): string[]
  /** `mcp:*:list` and `mcp:*:call`. */
  all(actions?: readonly ('list' | 'call')[], protocol?: string): string[]
}>

export interface McpToolDefinition {
  name: string
  title?: string
  description: string
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean; consequentialHint?: boolean; debugging?: boolean }
  execute(input: Record<string, any>, options: { signal: AbortSignal }): unknown | Promise<unknown>
}

export interface McpCall { name: string; title: string | null; description: string; input: Record<string, unknown>; consequential: boolean; readOnly: boolean }
export interface McpCallEvent {
  outcome: 'ok' | 'error' | 'denied' | 'approved' | 'refused' | 'unknown' | 'unlisted' | 'unauthorized'
  name?: string
  /** `fingerprint` is the caller's verified pod id. */
  who?: { username: string | null; fingerprint: string | null }
  limit?: string
  detail?: string
}

export interface ServeMcpOptions {
  /** The realm whose WebMCP tools are served. Give this, `tools`, or both. */
  window?: object
  tools?: McpToolDefinition[]
  /** Exact tool names the page offers. Nothing is offered by default. */
  allow: string[]
  approve?: 'never' | 'consequential' | 'always'
  /** The person at THIS page. Answers `true` to allow. Default: a dialog in `window.document`, else deny. */
  prompt?: (call: McpCall, who: { username: string | null; fingerprint: string | null }, extra: { signal: AbortSignal }) => boolean | Promise<boolean>
  capture?: { list(): McpToolDefinition[]; subscribe?(fn: () => void): () => void } | null
  limits?: Partial<{ maxTools: number; maxSchemaBytes: number; maxInputBytes: number; maxResultBytes: number; maxInflight: number; maxCallsPerMinute: number; callTimeoutMs: number }>
  /** Replaces the registry-backed decision. */
  authorize?: (peer: string, tool: string, action: 'list' | 'call') => boolean
  onCall?: (event: McpCallEvent) => void
  onSession?: (event: { peer: string; state: 'open' | 'close' }) => void
  guard?: () => string | null
  server?: { name?: string; version?: string }
  timers?: object
  protocol?: string
  now?: () => number
}

export interface ServedMcp {
  readonly protocol: string
  sessions(): Array<{ peer: string; since: number }>
  list(): Promise<object[]>
  closeSessions(reason: string, peer?: string): Promise<number>
  close(): Promise<void>
}

export function serveMcpOnMesh(service: McpProtocolService | { api: McpProtocolService }, options: ServeMcpOptions): ServedMcp

export interface McpToolResult {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>
  structuredContent?: unknown
  isError?: boolean
  _meta?: Record<string, unknown>
  /** Always true: the result is data of the serving page. */
  untrusted: true
}

export interface McpMeshClient {
  readonly peer: string
  readonly closed: boolean
  request(method: string, params?: unknown, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<any>
  notify(method: string, params?: unknown): Promise<void>
  initialize(options?: { signal?: AbortSignal }): Promise<any>
  listTools(options?: { signal?: AbortSignal }): Promise<any[]>
  callTool(name: string, args?: Record<string, unknown>, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<McpToolResult>
  onToolsChanged(cb: () => void): () => void
  onLog(cb: (params: unknown) => void): () => void
  onClose(cb: () => void): () => void
  close(): void
  /** An MCP SDK `Transport` over this channel. */
  readonly transport: MeshMcpTransport
}

export class MeshMcpTransport {
  constructor(client: McpMeshClient)
  sessionId?: string
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: any) => void
  start(): Promise<void>
  send(message: any): Promise<void>
  close(): Promise<void>
}

export function openMcpOnMesh(channel: any): McpMeshClient
export function connectMcpOnMesh(service: McpProtocolService | { api: McpProtocolService }, peer: string, options?: { protocol?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<McpMeshClient>
