/**
 * @johnhenry/browsermesh-ingress/node: a Node HTTP/1.1 listener for a `createMeshIngress` handler.
 */
import type { MeshIngress } from './index.js'

export interface ListenOptions {
  port?: number
  host?: string
  /** Required to bind anything but loopback: a statement that TLS is terminated in front. */
  public?: boolean
  trustProxy?: boolean | number
  maxConnections?: number
  maxHeaderBytes?: number
  headersTimeoutMs?: number
  /** Node's bound on receiving a whole request, headers and body (default: 300000, or the ingress's `limits.uploadTimeoutMs` when that is longer; it was 60000 when bodies were small). */
  requestTimeoutMs?: number
  /**
   * Answer `GET` and `HEAD` for exactly this path (no query) with `{ ready, peers: { up, total } }`: 200 when the pods the ingress was told
   * to expect are linked, 503 before. Off unless given; it needs an ingress with `readiness()`. It shadows that path for every host.
   */
  readyPath?: string
  /**
   * Treat a client's end of file after its whole request (`nc -N`, `shutdown(SHUT_WR)`) as a half-close: the answer is still sent and the
   * connection ends after it. Off by default: with it, a hang-up that is only a FIN (an aborted browser fetch) no longer aborts the
   * handler until `limits.timeoutMs`.
   */
  halfClosedClients?: boolean
}

export function listenNode(ingress: Pick<MeshIngress, 'handle'> & Partial<Pick<MeshIngress, 'allowHeader' | 'limits' | 'readiness'>>, options?: ListenOptions): Promise<{ port: number; host: string; close(): Promise<void> }>
export function isLoopbackHost(host: string): boolean
export function clientAddressOf(socketAddress: string | undefined, xForwardedFor: string | undefined, trustProxy: boolean | number): string
