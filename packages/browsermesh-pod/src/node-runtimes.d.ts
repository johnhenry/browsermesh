import type { PodRuntime } from './index.js';

export interface NodeRuntimeOptions {
  /** How long `start()` waits for the module to load. Default 10000. */
  startTimeoutMs?: number;
}

/** `worker_threads` in the host process. Boundary `none`; advertised as the `node` lane. Not a security boundary. */
export declare function createWorkerThreadsRuntime(opts?: NodeRuntimeOptions): PodRuntime;

/**
 * A child Node process under the permission model (no fs write, no network,
 * no child processes, read access to only the entry and the hosted module).
 * Boundary `process`; advertised as the `node` lane. Not a sandbox against hostile code.
 */
export declare function createPermissionProcessRuntime(
  opts?: NodeRuntimeOptions & { nodePath?: string },
): PodRuntime;
