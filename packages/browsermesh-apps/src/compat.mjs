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
 *
 * Also exports BrowserToolRegistry, BrowserTool's counterpart: a
 * name-keyed collection of constructed tool instances used to dispatch
 * LLM-requested tool calls (see `registerMeshTools` in tools.mjs, which
 * calls `registry.register(...)`). Mirrors browsermesh-core's
 * compat.mjs's BrowserToolRegistry exactly, kept as a separate copy for
 * the same standalone-use reason BrowserTool itself is duplicated here.
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

/**
 * Returns true if `tool` looks like a BrowserTool: it exposes a working
 * `.spec` getter (with a non-empty string `.name`) and an `.execute`
 * method. Duck-typed rather than `instanceof BrowserTool` on purpose —
 * see the module header: this package vendors its own copy of the
 * `BrowserTool` shim (same as browsermesh-core's compat.mjs) for
 * standalone use, so a tool built against one package's `BrowserTool`
 * class is not `instanceof` another package's class even though it has
 * the identical shape. Duck-typing lets `BrowserToolRegistry` accept any
 * of them.
 * @param {unknown} tool
 * @returns {boolean}
 */
function looksLikeBrowserTool(tool) {
  if (!tool || (typeof tool !== 'object' && typeof tool !== 'function')) return false;
  if (typeof tool.execute !== 'function') return false;
  let spec;
  try {
    spec = tool.spec;
  } catch {
    return false;
  }
  return !!spec && typeof spec.name === 'string' && spec.name.length > 0;
}

/**
 * BrowserToolRegistry -- holds constructed BrowserTool instances, keyed by
 * `.name`, and exposes the `.spec` list an `llmFn` (see the agent-runtime
 * plan) needs for tool-calling.
 *
 * `register()` duck-types its argument (see `looksLikeBrowserTool` above)
 * rather than requiring `instanceof BrowserTool`, for the same
 * cross-package "standalone use" reason `BrowserTool` itself avoids hard
 * class-identity assumptions.
 *
 * Registering a second tool under a name that's already registered
 * throws (it does not silently overwrite) — a name collision usually
 * means two unrelated tools accidentally share a name, and silently
 * dropping one would be a confusing, hard-to-debug failure mode. Call
 * `unregister(name)` first if replacing a tool is genuinely intended.
 */
export class BrowserToolRegistry {
  #tools = new Map();

  /**
   * @param {BrowserTool | { spec: object, execute: Function }} tool
   * @returns {BrowserTool} the same tool, for chaining
   */
  register(tool) {
    if (!looksLikeBrowserTool(tool)) {
      throw new TypeError(
        'BrowserToolRegistry.register(tool): tool must implement the BrowserTool shape ' +
        '(a `.spec` getter and an `.execute()` method) — got ' +
        (tool && tool.constructor ? tool.constructor.name : String(tool))
      );
    }
    const { name } = tool;
    if (this.#tools.has(name)) {
      throw new Error(`BrowserToolRegistry.register(tool): a tool named "${name}" is already registered; call unregister("${name}") first to replace it`);
    }
    this.#tools.set(name, tool);
    return tool;
  }

  /**
   * @param {string} name
   * @returns {BrowserTool | undefined}
   */
  get(name) {
    return this.#tools.get(name);
  }

  /** @returns {BrowserTool[]} all registered tool instances */
  list() {
    return [...this.#tools.values()];
  }

  /** @returns {object[]} the `.spec` of every registered tool */
  listSpecs() {
    return this.list().map((tool) => tool.spec);
  }

  /**
   * @param {string} name
   * @returns {boolean} true if a tool with that name was registered and removed
   */
  unregister(name) {
    return this.#tools.delete(name);
  }
}
