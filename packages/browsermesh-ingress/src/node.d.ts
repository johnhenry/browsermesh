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
  requestTimeoutMs?: number
}

export function listenNode(ingress: Pick<MeshIngress, 'handle'>, options?: ListenOptions): Promise<{ port: number; host: string; close(): Promise<void> }>
export function isLoopbackHost(host: string): boolean
export function clientAddressOf(socketAddress: string | undefined, xForwardedFor: string | undefined, trustProxy: boolean | number): string
