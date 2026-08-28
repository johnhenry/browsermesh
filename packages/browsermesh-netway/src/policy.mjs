/**
 * PolicyEngine — tagged-capability access control with optional callback overrides.
 *
 * The policy engine manages **scopes**, each holding a set of capability tags
 * (strings from {@link CAPABILITY}) and an optional custom policy callback.
 * When a network operation is attempted through a {@link ScopedNetwork}, the
 * engine checks whether the scope's capability set (or callback) permits the
 * operation.
 *
 * **Capability tag system:** Each operation maps to a capability tag (e.g.
 * `'tcp:connect'`, `'udp:send'`). A scope that holds the tag — or the wildcard
 * `'*'` — is allowed. If a custom `policy` callback is provided, it receives the
 * request and capability set and makes the final allow/deny decision, enabling
 * dynamic rules like rate limiting or address filtering.
 *
 * @module policy
 */

import { CAPABILITY } from './constants.mjs';

/**
 * Manages named policy scopes and evaluates capability-based access decisions.
 */
export class PolicyEngine {
  #scopes = new Map();
  #scopeCounter = 0;

  /**
   * Create a new policy scope with a set of capability tags and an optional
   * custom policy callback.
   *
   * @param {Object} [opts={}]
   * @param {string[]} [opts.capabilities=[]] - Capability tags granted to this scope
   *   (values from {@link CAPABILITY}, e.g. `['tcp:connect', 'dns:resolve']`).
   * @param {function({ capability: string, address?: string }, Set<string>): Promise<'allow'|'deny'>|'allow'|'deny'} [opts.policy]
   *   Optional callback that receives `(request, capabilitySet)` and returns
   *   `'allow'` or `'deny'`. When provided, this callback has final authority —
   *   the default tag-set check is bypassed.
   * @returns {string} A unique scope identifier (e.g. `'scope_1'`) used in
   *   subsequent {@link PolicyEngine#check} and {@link PolicyEngine#removeScope} calls.
   */
  createScope({ capabilities = [], policy } = {}) {
    const scopeId = `scope_${++this.#scopeCounter}`;
    this.#scopes.set(scopeId, {
      capabilities: new Set(capabilities),
      policy: policy || null,
    });
    return scopeId;
  }

  /**
   * Check whether a network operation is permitted within a scope.
   *
   * Evaluation order:
   * 1. If the scope does not exist, returns `'deny'`.
   * 2. If a custom policy callback is registered, it is called and its return
   *    value is authoritative.
   * 3. Otherwise, the scope's capability set is checked: the wildcard `'*'`
   *    allows everything; an exact tag match allows the specific operation;
   *    anything else is denied.
   *
   * @param {string} scopeId - The scope identifier returned by {@link PolicyEngine#createScope}.
   * @param {Object} request - Description of the operation being attempted.
   * @param {string} request.capability - The required capability tag (e.g. `'tcp:connect'`).
   * @param {string} [request.address] - The target address, provided for context in
   *   custom policy callbacks.
   * @returns {Promise<'allow'|'deny'>} The access decision.
   */
  async check(scopeId, request) {
    const scope = this.#scopes.get(scopeId);
    if (!scope) return 'deny';

    const { capabilities, policy } = scope;

    // If a custom policy callback is provided, it makes the final decision
    if (policy) {
      const result = await policy(request, capabilities);
      return result === 'allow' ? 'allow' : 'deny';
    }

    // Default: check if the requested capability is in the tag set
    if (capabilities.has(CAPABILITY.ALL)) return 'allow';
    if (capabilities.has(request.capability)) return 'allow';

    return 'deny';
  }

  /**
   * Remove a previously created scope. After removal, any {@link PolicyEngine#check}
   * calls referencing this scope will return `'deny'`.
   *
   * @param {string} scopeId - The scope identifier to remove.
   */
  removeScope(scopeId) {
    this.#scopes.delete(scopeId);
  }
}
