import type { PodRuntime } from './index.js';

export interface NodeRuntimeOptions {
  /** How long `start()` waits for the module to load. Default 10000. */
  startTimeoutMs?: number;
}

/** `code` of the error `createIsolatedVmRuntime()` throws when the optional `isolated-vm` addon cannot be loaded. */
export declare const ISOLATED_VM_UNAVAILABLE: "ERR_ISOLATED_VM_UNAVAILABLE";

export interface IsolatedVmRuntimeOptions extends NodeRuntimeOptions {
  /** Heap limit (MiB) when the driver passes none. Default 128; the floor is 8. */
  defaultMemMib?: number;
  /** Largest reply, as JSON text. Default 1 MiB. */
  maxReplyBytes?: number;
  /** Largest request, as JSON text. Default 1 MiB. */
  maxRequestBytes?: number;
  /** Total log text kept per pod; the rest is dropped. Default 1 MiB. */
  maxLogBytes?: number;
  /** Requests a pod may have outstanding. Default 32. */
  maxInFlight?: number;
  /** Called when V8 reports it lost control of an isolate. The pod is reported as crashed. */
  onCatastrophicError?: (message: string) => void;
  /** Replaces the loader of `isolated-vm` (tests). */
  load?: () => unknown;
}

/** Whether the optional `isolated-vm` addon can be loaded here, and why not. */
export declare function isolatedVmAvailability(opts?: { load?: () => unknown }): { available: boolean; reason?: string };

/**
 * One V8 isolate per pod through `isolated-vm`, in the host's own process.
 * Boundary `language`; advertised as the `isolate` lane. No ambient authority;
 * heap and per-call time limits. A V8 bug is a bug in the host process.
 * Throws an error whose `code` is `ISOLATED_VM_UNAVAILABLE` when the addon is missing.
 */
export declare function createIsolatedVmRuntime(opts?: IsolatedVmRuntimeOptions): PodRuntime;

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
