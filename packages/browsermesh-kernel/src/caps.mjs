/**
 * Caps — capability builder and enforcement.
 *
 * Builds a frozen capabilities object from a kernel instance and a set
 * of granted capability tags. The `requireCap` function enforces access
 * control by throwing CapabilityDeniedError for missing capabilities.
 *
 * @module caps
 */

import { KERNEL_CAP } from './constants.mjs';
import { CapabilityDeniedError } from './errors.mjs';

/**
 * Build a frozen capabilities object from granted capability tags.
 * Each granted tag maps to the corresponding kernel subsystem reference.
 *
 * @param {Object} kernel - Kernel instance with subsystem accessors.
 * @param {string[]} grantedCaps - Array of KERNEL_CAP tags to grant.
 * @param {string} [tenantId] - Tenant identifier, threaded through to
 *   {@link Kernel#meshFor} and {@link Kernel#networkFor} (if present on `kernel`)
 *   so a granted MESH/NET capability resolves to a tenant-scoped view rather than
 *   ambient access. Safe to omit for callers/mocks that don't wire mesh/network
 *   support -- `caps.mesh`/`caps.net` then fall back to their bare boolean markers.
 * @param {Object} [opts={}]
 * @param {string[]} [opts.networkCapabilities] - Network provider capability tags
 *   (e.g. `browsermesh-netway`'s `CAPABILITY.TCP_CONNECT`/`CAPABILITY.LOOPBACK`/etc.)
 *   to request via {@link Kernel#networkFor} for a granted NET capability. Defaults
 *   to `['loopback']` when omitted -- a deliberately narrow default (real outbound
 *   TCP/UDP/DNS access is NOT implied just by holding NET; a caller must opt in with
 *   a wider tag set, e.g. via `Kernel#createTenant`'s `networkCapabilities` option --
 *   never defaults to `CAPABILITY.ALL`, which would defeat the point of scoping).
 * @returns {Readonly<Object>} Frozen capabilities object.
 */
export function buildCaps(kernel, grantedCaps, tenantId, { networkCapabilities } = {}) {
  const caps = {};
  const granted = new Set(grantedCaps);
  const hasAll = granted.has(KERNEL_CAP.ALL);

  if (hasAll || granted.has(KERNEL_CAP.CLOCK)) {
    caps.clock = kernel.clock;
  }
  if (hasAll || granted.has(KERNEL_CAP.RNG)) {
    caps.rng = kernel.rng;
  }
  if (hasAll || granted.has(KERNEL_CAP.NET)) {
    // When the kernel was constructed with a real network provider (see
    // Kernel's `network` constructor option / `networkFor()`), hand the tenant a
    // real, policy-checked ScopedNetwork instead of a bare marker -- narrowed to
    // exactly `networkCapabilities` (default `['loopback']`, NOT `CAPABILITY.ALL`).
    // Falls back to the historical bare boolean marker when no network provider is
    // wired (e.g. plain `new Kernel()`, or a duck-typed mock kernel in tests), so
    // existing callers that only check truthiness are unaffected.
    const netView = typeof kernel.networkFor === 'function'
      ? kernel.networkFor(tenantId, { capabilities: networkCapabilities || ['loopback'] })
      : null;
    caps.net = netView || true;
  }
  if (hasAll || granted.has(KERNEL_CAP.FS)) {
    caps.fs = true; // FS access marker
  }
  if (hasAll || granted.has(KERNEL_CAP.IPC)) {
    caps.ipc = kernel.services;
  }
  if (hasAll || granted.has(KERNEL_CAP.STDIO)) {
    caps.stdio = true; // Stdio access marker — actual stdio is per-tenant
  }
  if (hasAll || granted.has(KERNEL_CAP.TRACE)) {
    caps.trace = kernel.tracer;
  }
  if (hasAll || granted.has(KERNEL_CAP.CHAOS)) {
    caps.chaos = kernel.chaos;
  }
  if (hasAll || granted.has(KERNEL_CAP.ENV)) {
    caps.env = true; // Env access marker — actual env is per-tenant
  }
  if (hasAll || granted.has(KERNEL_CAP.SIGNAL)) {
    caps.signal = true; // Signal access marker
  }
  if (hasAll || granted.has(KERNEL_CAP.MESH)) {
    // When the kernel was constructed with a real mesh provider (see
    // Kernel's `mesh` constructor option / `meshFor()`), hand the tenant a
    // scoped send/receive view instead of a bare marker -- restricted to
    // send/receive, and gated per-peer by the injected PeerRegistry's
    // checkAccess(), not the raw PeerNode API. Falls back to the historical
    // bare boolean marker when no mesh provider is wired (e.g. plain
    // `new Kernel()`, or a duck-typed mock kernel in tests), so existing
    // callers that only check truthiness are unaffected.
    const meshView = typeof kernel.meshFor === 'function' ? kernel.meshFor(tenantId) : null;
    caps.mesh = meshView || true;
  }
  if (hasAll || granted.has(KERNEL_CAP.PAYMENT)) {
    caps.payment = true; // Payment channel access marker
  }
  if (hasAll || granted.has(KERNEL_CAP.CONSENSUS)) {
    caps.consensus = true; // Consensus protocol access marker
  }

  // Store the granted set for requireCap checks
  caps._granted = Object.freeze([...granted]);

  return Object.freeze(caps);
}

/**
 * Require that a capability tag is present in a caps object.
 *
 * @param {Object} caps - Capabilities object from buildCaps.
 * @param {string} capTag - The required KERNEL_CAP tag.
 * @throws {CapabilityDeniedError} If the capability is not granted.
 */
export function requireCap(caps, capTag) {
  if (!caps || !caps._granted) throw new CapabilityDeniedError(capTag);
  const granted = new Set(caps._granted);
  if (granted.has(KERNEL_CAP.ALL)) return;
  if (granted.has(capTag)) return;
  throw new CapabilityDeniedError(capTag);
}

/**
 * Builder class for constructing capabilities (alternative to buildCaps).
 */
export class CapsBuilder {
  /**
   * Build capabilities from kernel and granted tags.
   *
   * @param {Object} kernel - Kernel instance.
   * @param {string[]} grantedCaps - Granted capability tags.
   * @returns {Readonly<Object>} Frozen capabilities object.
   */
  build(kernel, grantedCaps) {
    return buildCaps(kernel, grantedCaps);
  }
}
