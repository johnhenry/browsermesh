/**
 * compat.mjs -- BrowserTool shim for standalone use.
 *
 * In clawser, BrowserTool is the base class for AI-agent-callable tools.
 * Subclasses override name/description/parameters/permission as GETTERS
 * (not constructor-assigned properties) — this shim mirrors that exactly
 * (see web/clawser-tools.js). An earlier version of this shim tried to
 * assign `this.name = ...` in the constructor, which threw
 * "Cannot set property name of #<Tool> which has only a getter" for
 * every real subclass, since none of them define a setter (same bug
 * found and fixed in browsermesh-core's compat.mjs).
 */
export class BrowserTool {
  /** @returns {object} ToolSpec-compatible object */
  get spec() {
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameters,
      required_permission: this.permission,
    };
  }

  get name() { throw new Error('implement name'); }
  get description() { throw new Error('implement description'); }
  get parameters() { return { type: 'object', properties: {} }; }
  get permission() { return 'internal'; }

  async execute(_params) { throw new Error('Not implemented'); }
}
