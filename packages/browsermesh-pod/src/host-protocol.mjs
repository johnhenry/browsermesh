/**
 * host-protocol.mjs — the lane-agnostic pod-host control surface (issue
 * #185, the "hosted pods control surface" follow-up to WP1–WP5).
 *
 * This file is **plain data plus one reference driver**. It deliberately
 * lives in `@johnhenry/browsermesh-pod`, not in
 * `@johnhenry/browsermesh-apps`, so that the two places a hosted pod
 * actually runs — a V8 isolate (a Worker / Durable Object) and a microVM
 * host agent — can `import` the verb set, the podspec validator and the
 * wire shapes without pulling in the whole app/agent runtime (marketplace,
 * payments, quotas, GPU...). The gated, audited *service* that speaks this
 * protocol over the mesh is `createPodHostService()` in
 * `browsermesh-apps/src/pod-host-service.mjs`; everything later (mesh://
 * routes, meshctl tools, an external CLI, a supervisor) is a projection of
 * the same eight verbs defined here.
 *
 * The eight verbs (`POD_HOST_VERB`) are the whole control surface:
 *
 *   spawn    create a pod from a podspec
 *   status   one pod's lifecycle state
 *   send     deliver a message to a pod
 *   exec     run argv inside a pod (lane-dependent — see POD_LANE_VERBS)
 *   snapshot freeze a pod to durable storage (lane-dependent)
 *   restore  thaw a snapshotted pod (lane-dependent)
 *   drain    stop a pod, notifying peers
 *   list     every pod this host tracks
 *
 * Not every lane can honour every verb, and that is a first-class part of
 * the contract rather than a runtime surprise: `POD_LANE_VERBS` /
 * `laneSupports()` describe it statically, and a driver refusing a verb its
 * lane structurally cannot do throws `POD_HOST_ERROR.ELANE` (as opposed to
 * `ENOTSUP`, which means "this particular driver did not implement an
 * otherwise lane-compatible verb").
 *
 * Zero dependencies, no browser-only globals, no `node:` imports — this
 * module must load unchanged in Node, a browser, `workerd` and a microVM
 * guest.
 */

// ---------------------------------------------------------------------------
// Verbs, lanes, lifecycle
// ---------------------------------------------------------------------------

/** The complete pod-host verb set. Every later surface projects these eight. */
export const POD_HOST_VERB = Object.freeze({
  SPAWN: 'spawn',
  STATUS: 'status',
  SEND: 'send',
  EXEC: 'exec',
  SNAPSHOT: 'snapshot',
  RESTORE: 'restore',
  DRAIN: 'drain',
  LIST: 'list',
})

/** Every verb string, in declaration order. @type {readonly string[]} */
export const POD_HOST_VERBS = Object.freeze(Object.values(POD_HOST_VERB))

/**
 * Isolation lanes a pod host can offer.
 *
 * These strings are intentionally IDENTICAL to `RUNTIME_CLASS` in
 * `packages/browsermesh-apps/src/resources.mjs` (issue #185 WP4), which is
 * what `ResourceScorer` matches on as `runtime:<class>` capabilities. They
 * are duplicated rather than imported ON PURPOSE: `browsermesh-pod` must
 * stay importable from a Worker or a microVM guest without dragging in
 * `browsermesh-apps`. If one side ever gains a lane, add it to both.
 */
export const POD_LANE = Object.freeze({
  ISOLATE: 'isolate',
  MICROVM: 'microvm',
  NODE: 'node',
  BROWSER: 'browser',
})

/** Every lane string. @type {readonly string[]} */
export const POD_LANES = Object.freeze(Object.values(POD_LANE))

/**
 * Hosted-pod lifecycle states, matching `docs/hosted-pods.md` §5.3's state
 * diagram, plus a terminal `gone`.
 *
 * The diagram's `Draining --> Cold` + `Cold --> [*]: destroy` pair is
 * represented here as two allowed edges out of `draining`: back to `cold`
 * (the rootfs/DO survives and the pod can boot again — what
 * `spikes/vm-pod-host`'s `VmPod` actually does) and straight to `gone` (the
 * pod is forgotten). `gone` is terminal and is what a drained pod reports
 * from `status` when the host keeps a tombstone.
 */
export const POD_LIFECYCLE = Object.freeze({
  COLD: 'cold',
  BOOTING: 'booting',
  REGISTERED: 'registered',
  SERVING: 'serving',
  PAUSED: 'paused',
  SNAPSHOTTED: 'snapshotted',
  RESTORING: 'restoring',
  DRAINING: 'draining',
  GONE: 'gone',
})

/** Every lifecycle state string. @type {readonly string[]} */
export const POD_LIFECYCLE_STATES = Object.freeze(Object.values(POD_LIFECYCLE))

/**
 * Allowed lifecycle transitions, `from -> readonly to[]`. A state missing
 * from this map, or a `to` missing from its array, is not a legal
 * transition — see `canTransition()`.
 *
 * `gone` is terminal (empty array). Every non-terminal state may jump
 * straight to `gone`, because a host losing its VMM/isolate is not a
 * graceful drain and still has to be reportable.
 */
export const POD_LIFECYCLE_TRANSITIONS = Object.freeze({
  [POD_LIFECYCLE.COLD]: Object.freeze([POD_LIFECYCLE.BOOTING, POD_LIFECYCLE.GONE]),
  [POD_LIFECYCLE.BOOTING]: Object.freeze([POD_LIFECYCLE.REGISTERED, POD_LIFECYCLE.GONE]),
  [POD_LIFECYCLE.REGISTERED]: Object.freeze([
    POD_LIFECYCLE.SERVING, POD_LIFECYCLE.PAUSED, POD_LIFECYCLE.DRAINING, POD_LIFECYCLE.GONE,
  ]),
  [POD_LIFECYCLE.SERVING]: Object.freeze([
    POD_LIFECYCLE.REGISTERED, POD_LIFECYCLE.DRAINING, POD_LIFECYCLE.GONE,
  ]),
  [POD_LIFECYCLE.PAUSED]: Object.freeze([
    POD_LIFECYCLE.SNAPSHOTTED, POD_LIFECYCLE.REGISTERED, POD_LIFECYCLE.DRAINING, POD_LIFECYCLE.GONE,
  ]),
  [POD_LIFECYCLE.SNAPSHOTTED]: Object.freeze([POD_LIFECYCLE.RESTORING, POD_LIFECYCLE.GONE]),
  [POD_LIFECYCLE.RESTORING]: Object.freeze([POD_LIFECYCLE.REGISTERED, POD_LIFECYCLE.GONE]),
  [POD_LIFECYCLE.DRAINING]: Object.freeze([POD_LIFECYCLE.COLD, POD_LIFECYCLE.GONE]),
  [POD_LIFECYCLE.GONE]: Object.freeze([]),
})

/**
 * Is `from -> to` a legal lifecycle transition?
 *
 * @param {string} from - A `POD_LIFECYCLE` value.
 * @param {string} to - A `POD_LIFECYCLE` value.
 * @returns {boolean} `false` for any unknown state on either side.
 */
export function canTransition(from, to) {
  const allowed = POD_LIFECYCLE_TRANSITIONS[from]
  if (!allowed) return false
  return allowed.includes(to)
}

/**
 * Which verbs each lane can structurally honour (issue #185 §2's two-lane
 * comparison table, reduced to the control surface).
 *
 * - An **isolate** has no shell and no process to freeze to disk, so
 *   `exec`, `snapshot` and `restore` are `ELANE` there *today* — Durable
 *   Object hibernation is automatic, not a verb a caller drives.
 * - A **browser** pod host is a tab: same no-shell, no-snapshot story.
 * - **microvm** and **node** hosts can do all eight.
 */
export const POD_LANE_VERBS = Object.freeze({
  [POD_LANE.ISOLATE]: Object.freeze([
    POD_HOST_VERB.SPAWN, POD_HOST_VERB.STATUS, POD_HOST_VERB.SEND,
    POD_HOST_VERB.DRAIN, POD_HOST_VERB.LIST,
  ]),
  [POD_LANE.MICROVM]: Object.freeze([...POD_HOST_VERBS]),
  [POD_LANE.NODE]: Object.freeze([...POD_HOST_VERBS]),
  [POD_LANE.BROWSER]: Object.freeze([
    POD_HOST_VERB.SPAWN, POD_HOST_VERB.STATUS, POD_HOST_VERB.SEND,
    POD_HOST_VERB.DRAIN, POD_HOST_VERB.LIST,
  ]),
})

/**
 * Can `lane` honour `verb` at all? An unknown lane is treated as capable of
 * nothing (`false`), so a typo'd lane fails loudly rather than silently
 * advertising the full verb set.
 *
 * @param {string} lane - A `POD_LANE` value.
 * @param {string} verb - A `POD_HOST_VERB` value.
 * @returns {boolean}
 */
export function laneSupports(lane, verb) {
  const verbs = POD_LANE_VERBS[lane]
  if (!verbs) return false
  return verbs.includes(verb)
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Machine-readable pod-host error codes. Deliberately errno-shaped, like
 * `browsermesh-kernel`'s own `KERNEL_ERROR`.
 *
 * `ELANE` is the one code with no errno ancestor: it means "this lane
 * structurally cannot do this verb" (exec on an isolate; snapshot/restore
 * on an isolate today). `ENOTSUP` means "this particular driver does not
 * implement an otherwise lane-compatible verb" — a gap, not a law.
 */
export const POD_HOST_ERROR = Object.freeze({
  EACCES: 'EACCES',
  ENOENT: 'ENOENT',
  EEXIST: 'EEXIST',
  EINVAL: 'EINVAL',
  ENOTSUP: 'ENOTSUP',
  ELANE: 'ELANE',
  ETIMEDOUT: 'ETIMEDOUT',
  EBUSY: 'EBUSY',
})

/**
 * The error every `PodHostDriver` method rejects with. Carries a
 * `POD_HOST_ERROR` code so the wire layer can round-trip it as
 * `{ code, message }` without losing the distinction between "denied",
 * "no such pod" and "wrong lane".
 */
export class PodHostDriverError extends Error {
  /** @type {string} A `POD_HOST_ERROR` value. */
  code

  /** @type {object|null} Optional structured context (pod name, lane, ...). */
  details

  /**
   * @param {string} code - A `POD_HOST_ERROR` value.
   * @param {string} message
   * @param {object} [details]
   */
  constructor(code, message, details = null) {
    super(message)
    this.name = 'PodHostDriverError'
    this.code = code
    this.details = details
  }

  /** @returns {{code: string, message: string}} The wire shape. */
  toJSON() {
    return { code: this.code, message: this.message }
  }

  /**
   * Rebuild a `PodHostDriverError` from a wire `{ code, message }` (or from
   * anything else, defaulting to `EINVAL`). Used by the client side of the
   * mesh service to re-throw a remote failure locally.
   *
   * @param {*} err
   * @returns {PodHostDriverError}
   */
  static from(err) {
    if (err instanceof PodHostDriverError) return err
    const code = (err && typeof err.code === 'string' && err.code) || POD_HOST_ERROR.EINVAL
    const message = (err && typeof err.message === 'string' && err.message) || String(err)
    return new PodHostDriverError(code, message, err && err.details ? err.details : null)
  }
}

/**
 * Build a `PodHostDriver` method that always refuses, for a verb a driver
 * cannot serve. Use it to fill in the gaps of a partial driver so every
 * driver still has all eight methods and callers never hit
 * `driver.exec is not a function`.
 *
 * Defaults to `ELANE` when `lane` says the verb is structurally impossible
 * there, and to `ENOTSUP` otherwise (a driver gap on a lane that could, in
 * principle, do it).
 *
 * @param {string} verb - A `POD_HOST_VERB` value.
 * @param {string} [lane] - A `POD_LANE` value.
 * @param {object} [opts]
 * @param {string} [opts.code] - Force a specific `POD_HOST_ERROR` code.
 * @param {string} [opts.message] - Override the generated message.
 * @returns {() => Promise<never>} An async function that always rejects.
 */
export function createUnsupportedDriverMethod(verb, lane, opts = {}) {
  const error = unsupportedVerbError(verb, lane, opts)
  return async function unsupportedDriverMethod() {
    throw error
  }
}

/**
 * The `ELANE`/`ENOTSUP` decision in one place, shared by
 * `createUnsupportedDriverMethod()` and `InMemoryPodHostDriver`'s own
 * per-call verb gate.
 *
 * @param {string} verb
 * @param {string} [lane]
 * @param {{code?: string, message?: string}} [opts]
 * @returns {PodHostDriverError}
 */
function unsupportedVerbError(verb, lane, opts = {}) {
  const laneKnown = Boolean(POD_LANE_VERBS[lane])
  const code = opts.code
    || (laneKnown && !laneSupports(lane, verb) ? POD_HOST_ERROR.ELANE : POD_HOST_ERROR.ENOTSUP)
  const message = opts.message || (code === POD_HOST_ERROR.ELANE
    ? `lane '${lane}' cannot '${verb}'`
    : `driver${lane ? ` (lane '${lane}')` : ''} does not implement '${verb}'`)
  return new PodHostDriverError(code, message, { verb, lane: lane ?? null })
}

// ---------------------------------------------------------------------------
// Podspec validation
// ---------------------------------------------------------------------------

/** What a podspec's `run.kind` may be. */
const RUN_KINDS = Object.freeze(['skill', 'module', 'rootfs', 'command'])

/** `run.kind`s that default to the isolate lane; the rest default to microvm. */
const ISOLATE_RUN_KINDS = Object.freeze(['skill', 'module'])

/** Restart policies a podspec may ask for. */
const RESTART_POLICIES = Object.freeze(['never', 'on-failure', 'always'])

/** Pod names are path/URL/CLI-safe: this is the whole grammar. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

const SPEC_KEYS = Object.freeze(['name', 'lane', 'run', 'limits', 'caps', 'env', 'budget', 'restart', 'labels'])
const RUN_KEYS = Object.freeze(['kind', 'ref', 'entry', 'input'])
const LIMIT_KEYS = Object.freeze(['vcpus', 'memMib', 'timeoutMs', 'netRateLimiter', 'blockRateLimiter'])
const BUDGET_KEYS = Object.freeze(['credits', 'currency'])
const RESTART_KEYS = Object.freeze(['policy', 'maxRestarts', 'backoffMs'])

/** @param {*} value @returns {boolean} */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @param {object} obj
 * @param {readonly string[]} allowed
 * @param {string} where - Dotted path used in the error message.
 * @param {string[]} errors - Accumulator, appended to in place.
 */
function rejectUnknownKeys(obj, allowed, where, errors) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) errors.push(`${where}: unknown key '${key}'`)
  }
}

/**
 * @param {*} value
 * @param {string} where
 * @param {string[]} errors
 * @returns {Record<string, string>|undefined}
 */
function validateStringMap(value, where, errors) {
  if (value === undefined) return undefined
  if (!isPlainObject(value)) {
    errors.push(`${where} must be an object`)
    return undefined
  }
  /** @type {Record<string, string>} */
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      errors.push(`${where}.${key} must be a string`)
      continue
    }
    out[key] = entry
  }
  return out
}

/**
 * @param {*} value
 * @param {string} where
 * @param {string[]} errors
 * @param {object} [opts]
 * @param {boolean} [opts.integer=false]
 * @returns {number|undefined}
 */
function validatePositiveNumber(value, where, errors, { integer = false } = {}) {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    errors.push(`${where} must be a positive finite number`)
    return undefined
  }
  if (integer && !Number.isInteger(value)) {
    errors.push(`${where} must be an integer`)
    return undefined
  }
  return value
}

/**
 * Validate and normalize a **podspec** — the payload of the `spawn` verb.
 *
 * Normalization is deliberately minimal and total: the only defaults
 * applied are `lane` (derived from `run.kind`: `isolate` for
 * `skill`/`module`, `microvm` for `command`/`rootfs`) and
 * `restart.policy` (`'never'`). Optional sections that were absent stay
 * absent in the normalized value, so a driver can tell "no limits asked
 * for" apart from "limits asked for, all defaults".
 *
 * Unknown keys are an error, not ignored: a mistyped `limits.memMB` that
 * silently did nothing would be a quota bug nobody notices until the bill.
 *
 * @param {object} spec
 * @returns {{ok: true, value: object}|{ok: false, errors: string[]}}
 */
export function validatePodSpec(spec) {
  /** @type {string[]} */
  const errors = []

  if (!isPlainObject(spec)) {
    return { ok: false, errors: ['podspec must be an object'] }
  }
  rejectUnknownKeys(spec, SPEC_KEYS, 'podspec', errors)

  // -- name ---------------------------------------------------------------
  if (typeof spec.name !== 'string' || !spec.name) {
    errors.push('name is required and must be a non-empty string')
  } else if (!NAME_PATTERN.test(spec.name)) {
    errors.push(`name '${spec.name}' must match ${NAME_PATTERN}`)
  }

  // -- run ----------------------------------------------------------------
  /** @type {object|null} */
  let run = null
  if (!isPlainObject(spec.run)) {
    errors.push('run is required and must be an object')
  } else {
    rejectUnknownKeys(spec.run, RUN_KEYS, 'run', errors)
    if (!RUN_KINDS.includes(spec.run.kind)) {
      errors.push(`run.kind must be one of ${RUN_KINDS.join('|')}`)
    }
    if (typeof spec.run.ref !== 'string' || !spec.run.ref) {
      errors.push('run.ref is required and must be a non-empty string')
    }
    if (spec.run.entry !== undefined && typeof spec.run.entry !== 'string') {
      errors.push('run.entry must be a string')
    }
    run = { kind: spec.run.kind, ref: spec.run.ref }
    if (spec.run.entry !== undefined) run.entry = spec.run.entry
    if (spec.run.input !== undefined) run.input = spec.run.input
  }

  // -- lane (defaulted from run.kind) --------------------------------------
  let lane
  if (spec.lane === undefined) {
    lane = run && ISOLATE_RUN_KINDS.includes(run.kind) ? POD_LANE.ISOLATE : POD_LANE.MICROVM
  } else if (!POD_LANES.includes(spec.lane)) {
    errors.push(`lane must be one of ${POD_LANES.join('|')}`)
  } else {
    lane = spec.lane
  }

  // -- limits --------------------------------------------------------------
  /** @type {object|undefined} */
  let limits
  if (spec.limits !== undefined) {
    if (!isPlainObject(spec.limits)) {
      errors.push('limits must be an object')
    } else {
      rejectUnknownKeys(spec.limits, LIMIT_KEYS, 'limits', errors)
      limits = {}
      const vcpus = validatePositiveNumber(spec.limits.vcpus, 'limits.vcpus', errors, { integer: true })
      if (vcpus !== undefined) limits.vcpus = vcpus
      const memMib = validatePositiveNumber(spec.limits.memMib, 'limits.memMib', errors, { integer: true })
      if (memMib !== undefined) limits.memMib = memMib
      const timeoutMs = validatePositiveNumber(spec.limits.timeoutMs, 'limits.timeoutMs', errors)
      if (timeoutMs !== undefined) limits.timeoutMs = timeoutMs
      for (const key of ['netRateLimiter', 'blockRateLimiter']) {
        if (spec.limits[key] === undefined) continue
        if (!isPlainObject(spec.limits[key])) {
          errors.push(`limits.${key} must be an object`)
          continue
        }
        // Passed through verbatim: the shape is Firecracker's own rate
        // limiter document and only lane B knows how to read it.
        limits[key] = { ...spec.limits[key] }
      }
    }
  }

  // -- caps ----------------------------------------------------------------
  /** @type {string[]|undefined} */
  let caps
  if (spec.caps !== undefined) {
    if (!Array.isArray(spec.caps)) {
      errors.push('caps must be an array of strings')
    } else {
      // Validated as strings only, NOT against a copy of `KERNEL_CAP` —
      // that enum lives in `@johnhenry/browsermesh-kernel` and this package
      // must not depend on it (see the module doc comment). The host, which
      // does know the kernel, is the enforcement point.
      caps = []
      for (const [i, cap] of spec.caps.entries()) {
        if (typeof cap !== 'string' || !cap) {
          errors.push(`caps[${i}] must be a non-empty string`)
          continue
        }
        caps.push(cap)
      }
    }
  }

  // -- env / labels ---------------------------------------------------------
  const env = validateStringMap(spec.env, 'env', errors)
  const labels = validateStringMap(spec.labels, 'labels', errors)

  // -- budget ---------------------------------------------------------------
  /** @type {object|undefined} */
  let budget
  if (spec.budget !== undefined) {
    if (!isPlainObject(spec.budget)) {
      errors.push('budget must be an object')
    } else {
      rejectUnknownKeys(spec.budget, BUDGET_KEYS, 'budget', errors)
      if (typeof spec.budget.credits !== 'number'
        || !Number.isFinite(spec.budget.credits)
        || spec.budget.credits < 0) {
        errors.push('budget.credits is required and must be a non-negative finite number')
      }
      if (spec.budget.currency !== undefined && typeof spec.budget.currency !== 'string') {
        errors.push('budget.currency must be a string')
      }
      budget = { credits: spec.budget.credits }
      if (spec.budget.currency !== undefined) budget.currency = spec.budget.currency
    }
  }

  // -- restart (policy defaulted to 'never') ---------------------------------
  let restart = { policy: 'never' }
  if (spec.restart !== undefined) {
    if (!isPlainObject(spec.restart)) {
      errors.push('restart must be an object')
    } else {
      rejectUnknownKeys(spec.restart, RESTART_KEYS, 'restart', errors)
      const policy = spec.restart.policy === undefined ? 'never' : spec.restart.policy
      if (!RESTART_POLICIES.includes(policy)) {
        errors.push(`restart.policy must be one of ${RESTART_POLICIES.join('|')}`)
      }
      restart = { policy }
      if (spec.restart.maxRestarts !== undefined) {
        if (!Number.isInteger(spec.restart.maxRestarts) || spec.restart.maxRestarts < 0) {
          errors.push('restart.maxRestarts must be a non-negative integer')
        } else {
          restart.maxRestarts = spec.restart.maxRestarts
        }
      }
      if (spec.restart.backoffMs !== undefined) {
        if (typeof spec.restart.backoffMs !== 'number'
          || !Number.isFinite(spec.restart.backoffMs)
          || spec.restart.backoffMs < 0) {
          errors.push('restart.backoffMs must be a non-negative finite number')
        } else {
          restart.backoffMs = spec.restart.backoffMs
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors }

  /** @type {Record<string, *>} */
  const value = { name: spec.name, lane, run, restart }
  if (limits !== undefined) value.limits = limits
  if (caps !== undefined) value.caps = caps
  if (env !== undefined) value.env = env
  if (budget !== undefined) value.budget = budget
  if (labels !== undefined) value.labels = labels
  return { ok: true, value }
}

// ---------------------------------------------------------------------------
// Verb-request validation
// ---------------------------------------------------------------------------

/**
 * @param {object} payload
 * @param {string[]} errors
 * @returns {string|undefined}
 */
function validateName(payload, errors) {
  if (typeof payload.name !== 'string' || !payload.name) {
    errors.push('name is required and must be a non-empty string')
    return undefined
  }
  if (!NAME_PATTERN.test(payload.name)) {
    errors.push(`name '${payload.name}' must match ${NAME_PATTERN}`)
    return undefined
  }
  return payload.name
}

/**
 * Validate and normalize the payload of ANY pod-host verb, `spawn`
 * included (which delegates to `validatePodSpec()`).
 *
 * The normalized `value` is what a driver should be handed — notably,
 * `exec`'s `command` is always a `string[]` on the way out, and `drain`'s
 * `cascade` is always a boolean.
 *
 * @param {string} verb - A `POD_HOST_VERB` value.
 * @param {object} [payload]
 * @returns {{ok: true, value: object}|{ok: false, errors: string[]}}
 */
export function validateVerbRequest(verb, payload = {}) {
  if (!POD_HOST_VERBS.includes(verb)) {
    return { ok: false, errors: [`unknown verb '${verb}'`] }
  }
  if (verb === POD_HOST_VERB.SPAWN) return validatePodSpec(payload)

  if (!isPlainObject(payload)) {
    return { ok: false, errors: [`${verb} payload must be an object`] }
  }

  /** @type {string[]} */
  const errors = []

  switch (verb) {
    case POD_HOST_VERB.STATUS:
    case POD_HOST_VERB.SNAPSHOT:
    case POD_HOST_VERB.RESTORE: {
      rejectUnknownKeys(payload, ['name'], verb, errors)
      const name = validateName(payload, errors)
      if (errors.length > 0) return { ok: false, errors }
      return { ok: true, value: { name } }
    }

    case POD_HOST_VERB.SEND: {
      rejectUnknownKeys(payload, ['name', 'to', 'payload'], verb, errors)
      const name = validateName(payload, errors)
      if (payload.to !== undefined && (typeof payload.to !== 'string' || !payload.to)) {
        errors.push('to must be a non-empty string when present')
      }
      if (!('payload' in payload) || payload.payload === undefined) {
        errors.push('payload is required')
      }
      if (errors.length > 0) return { ok: false, errors }
      /** @type {Record<string, *>} */
      const value = { name, payload: payload.payload }
      if (payload.to !== undefined) value.to = payload.to
      return { ok: true, value }
    }

    case POD_HOST_VERB.EXEC: {
      rejectUnknownKeys(payload, ['name', 'command', 'timeoutMs'], verb, errors)
      const name = validateName(payload, errors)
      /** @type {string[]} */
      let command = []
      if (typeof payload.command === 'string') {
        if (!payload.command) {
          errors.push('command must be a non-empty string or a non-empty string[]')
        }
        // A string command becomes a SINGLE-ELEMENT argv. It is deliberately
        // NOT shell-split: quoting rules differ per lane and guessing them
        // is how injection bugs happen. Pass an explicit argv array, or
        // `['sh', '-c', '<string>']` when a shell really is wanted.
        command = [payload.command]
      } else if (Array.isArray(payload.command)) {
        if (payload.command.length === 0) {
          errors.push('command must be a non-empty string or a non-empty string[]')
        }
        for (const [i, part] of payload.command.entries()) {
          if (typeof part !== 'string' || !part) errors.push(`command[${i}] must be a non-empty string`)
        }
        command = [...payload.command]
      } else {
        errors.push('command is required and must be a string or string[]')
      }
      const timeoutMs = validatePositiveNumber(payload.timeoutMs, 'timeoutMs', errors)
      if (errors.length > 0) return { ok: false, errors }
      /** @type {Record<string, *>} */
      const value = { name, command }
      if (timeoutMs !== undefined) value.timeoutMs = timeoutMs
      return { ok: true, value }
    }

    case POD_HOST_VERB.DRAIN: {
      rejectUnknownKeys(payload, ['name', 'cascade'], verb, errors)
      const name = validateName(payload, errors)
      if (payload.cascade !== undefined && typeof payload.cascade !== 'boolean') {
        errors.push('cascade must be a boolean')
      }
      if (errors.length > 0) return { ok: false, errors }
      return { ok: true, value: { name, cascade: payload.cascade === true } }
    }

    case POD_HOST_VERB.LIST:
    default: {
      rejectUnknownKeys(payload, [], verb, errors)
      if (errors.length > 0) return { ok: false, errors }
      return { ok: true, value: {} }
    }
  }
}

// ---------------------------------------------------------------------------
// Wire messages
// ---------------------------------------------------------------------------

/** Envelope type of a verb request. */
export const POD_HOST_REQUEST = 'pod-host:request'
/** Envelope type of a verb response. */
export const POD_HOST_RESPONSE = 'pod-host:response'
/** Envelope type of an unsolicited host event. */
export const POD_HOST_EVENT = 'pod-host:event'

/** Kinds of `POD_HOST_EVENT` a host pushes to interested requesters. */
export const POD_HOST_EVENT_KIND = Object.freeze({
  LIFECYCLE: 'lifecycle',
  LOG: 'log',
  EXIT: 'exit',
})

/** @type {number} Monotonic suffix making generated request ids unique within a process. */
let requestCounter = 0

/**
 * A request id that is unique per process without needing `crypto`
 * (`randomUUID` is used when available, which is everywhere this package
 * targets, but the counter fallback keeps the module total).
 *
 * @returns {string}
 */
function nextRequestId() {
  requestCounter += 1
  const rand = globalThis.crypto?.randomUUID?.()
  if (rand) return rand
  return `pod-host-${Date.now().toString(36)}-${requestCounter.toString(36)}`
}

/**
 * Build a `pod-host:request` envelope.
 *
 * @param {string} verb - A `POD_HOST_VERB` value.
 * @param {object} [payload]
 * @param {object} [opts]
 * @param {string} [opts.requestId] - Supply your own correlation id.
 * @returns {{type: string, requestId: string, verb: string, payload: object, ts: number}}
 */
export function createHostRequest(verb, payload = {}, { requestId } = {}) {
  return {
    type: POD_HOST_REQUEST,
    requestId: requestId || nextRequestId(),
    verb,
    payload,
    ts: Date.now(),
  }
}

/**
 * Build a `pod-host:response` envelope. `result` and `error` are always
 * present (as `null` when unused), matching `createRpcResponse()` in
 * `messages.mjs`.
 *
 * @param {string} requestId - The `createHostRequest()` id being answered.
 * @param {object} opts
 * @param {boolean} opts.ok
 * @param {*} [opts.result]
 * @param {{code: string, message: string}} [opts.error]
 * @returns {{type: string, requestId: string, ok: boolean, result: *, error: object|null, ts: number}}
 */
export function createHostResponse(requestId, { ok, result, error } = {}) {
  return {
    type: POD_HOST_RESPONSE,
    requestId,
    ok: Boolean(ok),
    result: result ?? null,
    error: error ? { code: error.code, message: error.message } : null,
    ts: Date.now(),
  }
}

/**
 * Build a `pod-host:event` envelope.
 *
 * @param {string} kind - A `POD_HOST_EVENT_KIND` value.
 * @param {object} [data]
 * @returns {{type: string, kind: string, data: object, ts: number}}
 */
export function createHostEvent(kind, data = {}) {
  return { type: POD_HOST_EVENT, kind, data, ts: Date.now() }
}

// ---------------------------------------------------------------------------
// The driver interface (documentation only — a typedef, not a class)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} PodHostDriverCapabilities
 * @property {string[]} verbs - The `POD_HOST_VERB` values this driver
 *   actually serves. Always a subset of `POD_LANE_VERBS[driver.lane]`.
 */

/**
 * @typedef {object} PodHostStatus
 * @property {string} name
 * @property {string} lane
 * @property {string} state - A `POD_LIFECYCLE` value.
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {object} [spec] - The normalized podspec, when the driver keeps it.
 * @property {string|null} [podId] - The hosted pod's own mesh identity, once known.
 */

/**
 * `PodHostDriver` — the lane adapter the pod-host service dispatches to.
 *
 * It is a **typedef, not a class**: a driver is any object with these
 * members, so a Worker, a Firecracker host agent and an in-memory fake can
 * all be one without inheriting anything. Every method returns a Promise.
 * A verb the driver cannot serve must REJECT with a `PodHostDriverError`
 * carrying `ELANE` (the lane structurally cannot) or `ENOTSUP` (this driver
 * did not implement it) — see `createUnsupportedDriverMethod()`, which
 * builds exactly such a method.
 *
 * `onEvent` is optional. A driver that has it pushes `createHostEvent()`
 * envelopes; the service forwards them to interested requesters.
 *
 * @typedef {object} PodHostDriver
 * @property {string} lane - A `POD_LANE` value.
 * @property {() => PodHostDriverCapabilities} capabilities
 * @property {(spec: object) => Promise<PodHostStatus>} spawn
 * @property {(name: string) => Promise<PodHostStatus>} status
 * @property {(name: string, msg: {to?: string, payload: *}) => Promise<object>} send
 * @property {(name: string, argv: string[], opts?: {timeoutMs?: number}) => Promise<{stdout: string, stderr: string, code: number}>} exec
 * @property {(name: string) => Promise<PodHostStatus>} snapshot
 * @property {(name: string) => Promise<PodHostStatus>} restore
 * @property {(name: string, opts?: {cascade?: boolean}) => Promise<PodHostStatus>} drain
 * @property {() => Promise<PodHostStatus[]>} list
 * @property {(fn: (event: object) => void) => (() => void)} [onEvent] - Subscribe
 *   to this driver's `createHostEvent()` output. Returns an unsubscribe function.
 */

// ---------------------------------------------------------------------------
// InMemoryPodHostDriver — the reference driver
// ---------------------------------------------------------------------------

/**
 * A complete, dependency-free `PodHostDriver` backed by a `Map` of fake
 * pods, running the real `POD_LIFECYCLE` state machine via
 * `canTransition()`. This is the driver tests, examples and every later
 * control surface (mesh:// routes, meshctl tools, the external CLI) use
 * when they need a host that behaves correctly without a workerd process or
 * a KVM box behind it.
 *
 * Lane is configurable (default `'node'`, which supports all eight verbs);
 * set `lane: 'isolate'` to get a driver that rejects `exec`/`snapshot`/
 * `restore` with `ELANE`, exactly as a real Worker host does.
 *
 * Drained pods are kept as tombstones in state `gone` so `status()` still
 * answers after a drain (and `list()` still shows them); `spawn()` reuses a
 * tombstoned name rather than reporting `EEXIST`.
 */
export class InMemoryPodHostDriver {
  /** @type {string} */
  #lane

  /** @type {Set<string>} */
  #verbs

  /** @type {Map<string, {name: string, lane: string, spec: object, state: string, createdAt: number, updatedAt: number, inbox: object[], execs: number}>} */
  #pods = new Map()

  /** @type {(argv: string[], ctx: {name: string, timeoutMs?: number}) => Promise<{stdout: string, stderr: string, code: number}>} */
  #exec

  /** @type {Set<(event: object) => void>} */
  #listeners = new Set()

  /**
   * @param {object} [opts]
   * @param {string} [opts.lane='node'] - A `POD_LANE` value.
   * @param {string[]} [opts.verbs] - Narrow the served verb set further than
   *   the lane already does (useful for testing `ENOTSUP` paths). Never
   *   widens it: a verb the lane cannot do stays `ELANE`.
   * @param {(argv: string[], ctx: {name: string, timeoutMs?: number}) => Promise<{stdout: string, stderr: string, code: number}>} [opts.exec]
   *   Injectable exec implementation. Defaults to echoing the argv back as
   *   `stdout` with `code: 0`.
   */
  constructor({ lane = POD_LANE.NODE, verbs, exec } = {}) {
    if (!POD_LANES.includes(lane)) {
      throw new Error(`InMemoryPodHostDriver: unknown lane '${lane}'`)
    }
    this.#lane = lane
    const laneVerbs = POD_LANE_VERBS[lane]
    this.#verbs = new Set(verbs ? laneVerbs.filter((verb) => verbs.includes(verb)) : laneVerbs)
    this.#exec = exec || (async (argv) => ({ stdout: argv.join(' '), stderr: '', code: 0 }))
  }

  /** @returns {string} A `POD_LANE` value. */
  get lane() {
    return this.#lane
  }

  /** @returns {PodHostDriverCapabilities} */
  capabilities() {
    return { verbs: [...this.#verbs] }
  }

  /**
   * Subscribe to this driver's lifecycle/log/exit events.
   * @param {(event: object) => void} fn
   * @returns {() => void} Unsubscribe.
   */
  onEvent(fn) {
    if (typeof fn !== 'function') return () => {}
    this.#listeners.add(fn)
    return () => { this.#listeners.delete(fn) }
  }

  // -- verbs ---------------------------------------------------------------

  /**
   * @param {object} spec - A podspec; validated with `validatePodSpec()`.
   * @returns {Promise<PodHostStatus>}
   */
  async spawn(spec) {
    this.#requireVerb(POD_HOST_VERB.SPAWN)
    const validated = validatePodSpec(spec)
    if (!validated.ok) {
      throw new PodHostDriverError(POD_HOST_ERROR.EINVAL, validated.errors.join('; '), { errors: validated.errors })
    }
    const value = validated.value
    const existing = this.#pods.get(value.name)
    if (existing && existing.state !== POD_LIFECYCLE.GONE) {
      throw new PodHostDriverError(POD_HOST_ERROR.EEXIST, `pod '${value.name}' already exists`, { name: value.name })
    }

    const now = Date.now()
    const record = {
      name: value.name,
      lane: this.#lane,
      spec: value,
      state: POD_LIFECYCLE.COLD,
      createdAt: now,
      updatedAt: now,
      inbox: [],
      execs: 0,
    }
    this.#pods.set(value.name, record)
    this.#transition(record, POD_LIFECYCLE.BOOTING, 'spawn')
    this.#transition(record, POD_LIFECYCLE.REGISTERED, 'spawn')
    return this.#snapshotOf(record)
  }

  /**
   * @param {string} name
   * @returns {Promise<PodHostStatus>}
   */
  async status(name) {
    this.#requireVerb(POD_HOST_VERB.STATUS)
    return this.#snapshotOf(this.#require(name))
  }

  /**
   * @param {string} name
   * @param {{to?: string, payload: *}} msg
   * @returns {Promise<{delivered: boolean, inbox: number}>}
   */
  async send(name, msg) {
    this.#requireVerb(POD_HOST_VERB.SEND)
    const record = this.#requireLive(name)
    record.inbox.push({ to: msg?.to ?? null, payload: msg?.payload ?? null, ts: Date.now() })
    record.updatedAt = Date.now()
    return { delivered: true, inbox: record.inbox.length }
  }

  /**
   * @param {string} name
   * @param {string[]} argv
   * @param {{timeoutMs?: number}} [opts]
   * @returns {Promise<{stdout: string, stderr: string, code: number}>}
   */
  async exec(name, argv, opts = {}) {
    this.#requireVerb(POD_HOST_VERB.EXEC)
    const record = this.#requireLive(name)
    this.#transition(record, POD_LIFECYCLE.SERVING, 'exec')
    try {
      const result = await this.#exec(argv, { name, timeoutMs: opts.timeoutMs })
      record.execs += 1
      this.#emit(createHostEvent(POD_HOST_EVENT_KIND.LOG, {
        name, lane: this.#lane, stream: 'stdout', chunk: result.stdout,
      }))
      return result
    } finally {
      this.#transition(record, POD_LIFECYCLE.REGISTERED, 'exec-done')
    }
  }

  /**
   * `registered -> paused -> snapshotted` (both edges, so a subscriber sees
   * the same two transitions a real microVM host emits).
   * @param {string} name
   * @returns {Promise<PodHostStatus>}
   */
  async snapshot(name) {
    this.#requireVerb(POD_HOST_VERB.SNAPSHOT)
    const record = this.#require(name)
    if (record.state === POD_LIFECYCLE.REGISTERED) this.#transition(record, POD_LIFECYCLE.PAUSED, 'snapshot')
    this.#transition(record, POD_LIFECYCLE.SNAPSHOTTED, 'snapshot')
    return this.#snapshotOf(record)
  }

  /**
   * `snapshotted -> restoring -> registered`.
   * @param {string} name
   * @returns {Promise<PodHostStatus>}
   */
  async restore(name) {
    this.#requireVerb(POD_HOST_VERB.RESTORE)
    const record = this.#require(name)
    this.#transition(record, POD_LIFECYCLE.RESTORING, 'restore')
    this.#transition(record, POD_LIFECYCLE.REGISTERED, 'restore')
    return this.#snapshotOf(record)
  }

  /**
   * `* -> draining -> gone`, plus an `exit` event. `cascade` is recorded on
   * the exit event; this driver has no child pods of its own to cascade to.
   * @param {string} name
   * @param {{cascade?: boolean}} [opts]
   * @returns {Promise<PodHostStatus>}
   */
  async drain(name, opts = {}) {
    this.#requireVerb(POD_HOST_VERB.DRAIN)
    const record = this.#require(name)
    if (record.state !== POD_LIFECYCLE.GONE) {
      this.#transition(record, POD_LIFECYCLE.DRAINING, 'drain')
      this.#transition(record, POD_LIFECYCLE.GONE, 'drain')
    }
    this.#emit(createHostEvent(POD_HOST_EVENT_KIND.EXIT, {
      name, lane: this.#lane, code: 0, cascade: opts.cascade === true,
    }))
    return this.#snapshotOf(record)
  }

  /** @returns {Promise<PodHostStatus[]>} Every tracked pod, tombstones included. */
  async list() {
    this.#requireVerb(POD_HOST_VERB.LIST)
    return [...this.#pods.values()].map((record) => this.#snapshotOf(record))
  }

  // -- internals -------------------------------------------------------------

  /**
   * Refuse a verb this driver does not serve, with `ELANE` when the lane
   * structurally cannot and `ENOTSUP` when only this driver's narrowed
   * `verbs` option excluded it.
   * @param {string} verb
   */
  #requireVerb(verb) {
    if (this.#verbs.has(verb)) return
    throw unsupportedVerbError(verb, this.#lane)
  }

  /** @param {string} name @returns {object} */
  #require(name) {
    const record = this.#pods.get(name)
    if (!record) throw new PodHostDriverError(POD_HOST_ERROR.ENOENT, `no pod named '${name}'`, { name })
    return record
  }

  /** @param {string} name @returns {object} A pod that is not a tombstone. */
  #requireLive(name) {
    const record = this.#require(name)
    if (record.state === POD_LIFECYCLE.GONE) {
      throw new PodHostDriverError(POD_HOST_ERROR.ENOENT, `pod '${name}' is gone`, { name })
    }
    return record
  }

  /** @param {object} record @param {string} to @param {string} reason */
  #transition(record, to, reason) {
    if (!canTransition(record.state, to)) {
      throw new PodHostDriverError(
        POD_HOST_ERROR.EBUSY,
        `pod '${record.name}' cannot go ${record.state} -> ${to}`,
        { name: record.name, from: record.state, to },
      )
    }
    const from = record.state
    record.state = to
    record.updatedAt = Date.now()
    this.#emit(createHostEvent(POD_HOST_EVENT_KIND.LIFECYCLE, {
      name: record.name, lane: this.#lane, from, to, reason,
    }))
  }

  /** @param {object} event */
  #emit(event) {
    for (const fn of [...this.#listeners]) {
      try {
        fn(event)
      } catch {
        // A throwing subscriber never breaks the driver or other
        // subscribers — same rule `mesh-service.mjs`'s event bus applies.
      }
    }
  }

  /** @param {object} record @returns {PodHostStatus} */
  #snapshotOf(record) {
    return {
      name: record.name,
      lane: record.lane,
      state: record.state,
      spec: record.spec,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      inbox: record.inbox.length,
      execs: record.execs,
      podId: null,
    }
  }
}
