/**
 * Tests for host-protocol.mjs — the lane-agnostic pod-host control surface
 * (issue #185's "hosted pods control surface", item 1).
 *
 * Four layers, mirroring the module's own structure:
 *   - the lifecycle state machine (`canTransition()` over every edge)
 *   - the validators (`validatePodSpec()` / `validateVerbRequest()`), every
 *     branch including the normalization defaults
 *   - the wire messages (round-trips through JSON, since these envelopes
 *     exist to cross a WebSocket)
 *   - `InMemoryPodHostDriver`, driven through a full lifecycle plus every
 *     refusal path (`ELANE`, `ENOTSUP`, `ENOENT`, `EEXIST`, `EINVAL`)
 *
 * Run:
 *   node --test test/host-protocol.test.mjs
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  POD_HOST_VERB,
  POD_HOST_VERBS,
  POD_LANE,
  POD_LANES,
  POD_LANE_VERBS,
  laneSupports,
  POD_LIFECYCLE,
  POD_LIFECYCLE_STATES,
  POD_LIFECYCLE_TRANSITIONS,
  canTransition,
  POD_HOST_ERROR,
  PodHostDriverError,
  createUnsupportedDriverMethod,
  validatePodSpec,
  validateVerbRequest,
  POD_HOST_REQUEST,
  POD_HOST_RESPONSE,
  POD_HOST_EVENT,
  POD_HOST_EVENT_KIND,
  createHostRequest,
  createHostResponse,
  createHostEvent,
  InMemoryPodHostDriver,
} from '../src/host-protocol.mjs'

/** The smallest podspec that validates, as a fresh object each call. */
function minimalSpec(overrides = {}) {
  return { name: 'alpha', run: { kind: 'skill', ref: 'greeter' }, ...overrides }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('host-protocol constants', () => {
  it('freezes every enum and exposes all eight verbs', () => {
    assert.ok(Object.isFrozen(POD_HOST_VERB))
    assert.ok(Object.isFrozen(POD_LANE))
    assert.ok(Object.isFrozen(POD_LIFECYCLE))
    assert.ok(Object.isFrozen(POD_LIFECYCLE_TRANSITIONS))
    assert.ok(Object.isFrozen(POD_HOST_ERROR))
    assert.deepEqual(POD_HOST_VERBS, [
      'spawn', 'status', 'send', 'exec', 'snapshot', 'restore', 'drain', 'list',
    ])
  })

  it('keeps POD_LANE identical to browsermesh-apps RUNTIME_CLASS strings', () => {
    // Duplicated-on-purpose values (see the module doc comment): this test
    // is the tripwire for the two copies drifting apart.
    assert.deepEqual([...POD_LANES].sort(), ['browser', 'isolate', 'microvm', 'node'])
  })

  it('declares nine lifecycle states matching docs/hosted-pods.md §5.3 plus gone', () => {
    assert.deepEqual(POD_LIFECYCLE_STATES, [
      'cold', 'booting', 'registered', 'serving',
      'paused', 'snapshotted', 'restoring', 'draining', 'gone',
    ])
  })

  it('gives the isolate lane no exec/snapshot/restore (no shell, no caller-driven freeze)', () => {
    assert.equal(laneSupports(POD_LANE.ISOLATE, POD_HOST_VERB.EXEC), false)
    assert.equal(laneSupports(POD_LANE.ISOLATE, POD_HOST_VERB.SNAPSHOT), false)
    assert.equal(laneSupports(POD_LANE.ISOLATE, POD_HOST_VERB.RESTORE), false)
    assert.equal(laneSupports(POD_LANE.ISOLATE, POD_HOST_VERB.SPAWN), true)
  })

  it('gives the browser lane exec (evaluate script in the page) but not snapshot/restore', () => {
    // issue #185 item 7's decision: a browser pod host has no shell, but it
    // DOES have a JS realm a privileged driver (CDP, extension) can
    // evaluate expressions in, so `exec` means "evaluate", not "spawn a
    // process", and is lane-capable rather than `ELANE`. Whether any given
    // driver actually implements it is separate -- see
    // `browser-host-driver.test.mjs`'s ENOTSUP case for the in-page driver,
    // which structurally cannot do this safely and says so.
    assert.equal(laneSupports(POD_LANE.BROWSER, POD_HOST_VERB.EXEC), true)
    assert.equal(laneSupports(POD_LANE.BROWSER, POD_HOST_VERB.SNAPSHOT), false)
    assert.equal(laneSupports(POD_LANE.BROWSER, POD_HOST_VERB.RESTORE), false)
    assert.equal(laneSupports(POD_LANE.BROWSER, POD_HOST_VERB.SPAWN), true)
  })

  it('gives the microvm and node lanes every verb', () => {
    for (const lane of [POD_LANE.MICROVM, POD_LANE.NODE]) {
      for (const verb of POD_HOST_VERBS) assert.equal(laneSupports(lane, verb), true)
    }
  })

  it('treats an unknown lane as capable of nothing', () => {
    assert.equal(laneSupports('gvisor', POD_HOST_VERB.SPAWN), false)
  })
})

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('canTransition', () => {
  it('has a transition entry for every state', () => {
    for (const state of POD_LIFECYCLE_STATES) {
      assert.ok(Array.isArray(POD_LIFECYCLE_TRANSITIONS[state]), `missing ${state}`)
    }
  })

  it('only ever names known states as targets', () => {
    for (const [from, targets] of Object.entries(POD_LIFECYCLE_TRANSITIONS)) {
      for (const to of targets) {
        assert.ok(POD_LIFECYCLE_STATES.includes(to), `${from} -> ${to} is not a state`)
      }
    }
  })

  it('accepts exactly the declared edges and rejects every other pair', () => {
    for (const from of POD_LIFECYCLE_STATES) {
      for (const to of POD_LIFECYCLE_STATES) {
        const expected = POD_LIFECYCLE_TRANSITIONS[from].includes(to)
        assert.equal(canTransition(from, to), expected, `${from} -> ${to}`)
      }
    }
  })

  it('walks the happy path the docs diagram describes', () => {
    const path = [
      POD_LIFECYCLE.COLD, POD_LIFECYCLE.BOOTING, POD_LIFECYCLE.REGISTERED,
      POD_LIFECYCLE.SERVING, POD_LIFECYCLE.REGISTERED, POD_LIFECYCLE.PAUSED,
      POD_LIFECYCLE.SNAPSHOTTED, POD_LIFECYCLE.RESTORING, POD_LIFECYCLE.REGISTERED,
      POD_LIFECYCLE.DRAINING, POD_LIFECYCLE.GONE,
    ]
    for (let i = 0; i < path.length - 1; i += 1) {
      assert.ok(canTransition(path[i], path[i + 1]), `${path[i]} -> ${path[i + 1]}`)
    }
  })

  it('makes gone terminal and lets draining also return to cold', () => {
    assert.deepEqual(POD_LIFECYCLE_TRANSITIONS[POD_LIFECYCLE.GONE], [])
    assert.equal(canTransition(POD_LIFECYCLE.GONE, POD_LIFECYCLE.BOOTING), false)
    assert.equal(canTransition(POD_LIFECYCLE.DRAINING, POD_LIFECYCLE.COLD), true)
  })

  it('rejects unknown states on either side', () => {
    assert.equal(canTransition('nope', POD_LIFECYCLE.BOOTING), false)
    assert.equal(canTransition(POD_LIFECYCLE.COLD, 'nope'), false)
    assert.equal(canTransition(undefined, undefined), false)
  })
})

// ---------------------------------------------------------------------------
// validatePodSpec
// ---------------------------------------------------------------------------

describe('validatePodSpec', () => {
  it('rejects a non-object', () => {
    for (const bad of [null, undefined, 'alpha', 42, []]) {
      const result = validatePodSpec(bad)
      assert.equal(result.ok, false)
      assert.deepEqual(result.errors, ['podspec must be an object'])
    }
  })

  it('requires a name matching the name grammar', () => {
    assert.equal(validatePodSpec(minimalSpec({ name: '' })).ok, false)
    assert.equal(validatePodSpec(minimalSpec({ name: 42 })).ok, false)
    assert.equal(validatePodSpec(minimalSpec({ name: '-leading-dash' })).ok, false)
    assert.equal(validatePodSpec(minimalSpec({ name: 'has space' })).ok, false)
    assert.equal(validatePodSpec(minimalSpec({ name: 'a'.repeat(65) })).ok, false)
    assert.equal(validatePodSpec(minimalSpec({ name: 'a.b_c-1' })).ok, true)
  })

  it('requires a run block with a known kind and a ref', () => {
    assert.match(validatePodSpec({ name: 'a' }).errors.join(), /run is required/)
    assert.match(
      validatePodSpec(minimalSpec({ run: { kind: 'container', ref: 'x' } })).errors.join(),
      /run.kind must be one of/,
    )
    assert.match(
      validatePodSpec(minimalSpec({ run: { kind: 'skill' } })).errors.join(),
      /run.ref is required/,
    )
    assert.match(
      validatePodSpec(minimalSpec({ run: { kind: 'skill', ref: 'x', entry: 7 } })).errors.join(),
      /run.entry must be a string/,
    )
  })

  it('keeps run.entry and run.input when supplied', () => {
    const result = validatePodSpec(minimalSpec({
      run: { kind: 'module', ref: 'npm:thing', entry: 'main.mjs', input: { seed: 1 } },
    }))
    assert.equal(result.ok, true)
    assert.deepEqual(result.value.run, {
      kind: 'module', ref: 'npm:thing', entry: 'main.mjs', input: { seed: 1 },
    })
  })

  it("defaults lane to 'isolate' for skill/module runs", () => {
    for (const kind of ['skill', 'module']) {
      const result = validatePodSpec(minimalSpec({ run: { kind, ref: 'x' } }))
      assert.equal(result.value.lane, POD_LANE.ISOLATE)
    }
  })

  it("defaults lane to 'microvm' for command/rootfs runs", () => {
    for (const kind of ['command', 'rootfs']) {
      const result = validatePodSpec(minimalSpec({ run: { kind, ref: 'x' } }))
      assert.equal(result.value.lane, POD_LANE.MICROVM)
    }
  })

  it('honours an explicit lane and rejects an unknown one', () => {
    assert.equal(validatePodSpec(minimalSpec({ lane: POD_LANE.NODE })).value.lane, 'node')
    assert.match(validatePodSpec(minimalSpec({ lane: 'gvisor' })).errors.join(), /lane must be one of/)
  })

  it("defaults restart.policy to 'never' and validates the rest", () => {
    assert.deepEqual(validatePodSpec(minimalSpec()).value.restart, { policy: 'never' })
    assert.deepEqual(
      validatePodSpec(minimalSpec({ restart: { maxRestarts: 3, backoffMs: 500 } })).value.restart,
      { policy: 'never', maxRestarts: 3, backoffMs: 500 },
    )
    assert.deepEqual(
      validatePodSpec(minimalSpec({ restart: { policy: 'on-failure' } })).value.restart,
      { policy: 'on-failure' },
    )
    assert.match(
      validatePodSpec(minimalSpec({ restart: { policy: 'sometimes' } })).errors.join(),
      /restart.policy must be one of/,
    )
    assert.match(
      validatePodSpec(minimalSpec({ restart: { maxRestarts: -1 } })).errors.join(),
      /maxRestarts must be a non-negative integer/,
    )
    assert.match(
      validatePodSpec(minimalSpec({ restart: { backoffMs: Number.NaN } })).errors.join(),
      /backoffMs must be a non-negative finite number/,
    )
    assert.match(validatePodSpec(minimalSpec({ restart: 'always' })).errors.join(), /restart must be an object/)
  })

  it('validates limits, passing rate limiters through verbatim', () => {
    const result = validatePodSpec(minimalSpec({
      limits: {
        vcpus: 2, memMib: 512, timeoutMs: 1500,
        netRateLimiter: { bandwidth: { size: 1, refill_time: 1 } },
        blockRateLimiter: { ops: { size: 2, refill_time: 2 } },
      },
    }))
    assert.equal(result.ok, true)
    assert.deepEqual(result.value.limits.netRateLimiter, { bandwidth: { size: 1, refill_time: 1 } })
    assert.equal(result.value.limits.vcpus, 2)

    assert.match(validatePodSpec(minimalSpec({ limits: { vcpus: 0 } })).errors.join(), /vcpus must be a positive/)
    assert.match(validatePodSpec(minimalSpec({ limits: { vcpus: 1.5 } })).errors.join(), /vcpus must be an integer/)
    assert.match(validatePodSpec(minimalSpec({ limits: { memMib: -8 } })).errors.join(), /memMib must be a positive/)
    assert.match(
      validatePodSpec(minimalSpec({ limits: { timeoutMs: Number.POSITIVE_INFINITY } })).errors.join(),
      /timeoutMs must be a positive/,
    )
    assert.match(
      validatePodSpec(minimalSpec({ limits: { netRateLimiter: 'fast' } })).errors.join(),
      /netRateLimiter must be an object/,
    )
    assert.match(validatePodSpec(minimalSpec({ limits: 2 })).errors.join(), /limits must be an object/)
  })

  it('validates caps as a string array without checking them against KERNEL_CAP', () => {
    const result = validatePodSpec(minimalSpec({ caps: ['net', 'mesh', 'not-a-real-cap'] }))
    assert.equal(result.ok, true)
    assert.deepEqual(result.value.caps, ['net', 'mesh', 'not-a-real-cap'])
    assert.match(validatePodSpec(minimalSpec({ caps: 'net' })).errors.join(), /caps must be an array/)
    assert.match(validatePodSpec(minimalSpec({ caps: [1] })).errors.join(), /caps\[0\] must be a non-empty string/)
  })

  it('requires env and labels to be string maps', () => {
    const result = validatePodSpec(minimalSpec({ env: { A: '1' }, labels: { team: 'core' } }))
    assert.deepEqual(result.value.env, { A: '1' })
    assert.deepEqual(result.value.labels, { team: 'core' })
    assert.match(validatePodSpec(minimalSpec({ env: { A: 1 } })).errors.join(), /env.A must be a string/)
    assert.match(validatePodSpec(minimalSpec({ labels: [] })).errors.join(), /labels must be an object/)
  })

  it('validates budget credits and currency', () => {
    assert.deepEqual(validatePodSpec(minimalSpec({ budget: { credits: 0 } })).value.budget, { credits: 0 })
    assert.deepEqual(
      validatePodSpec(minimalSpec({ budget: { credits: 10, currency: 'bmc' } })).value.budget,
      { credits: 10, currency: 'bmc' },
    )
    assert.match(validatePodSpec(minimalSpec({ budget: {} })).errors.join(), /budget.credits is required/)
    assert.match(validatePodSpec(minimalSpec({ budget: { credits: -1 } })).errors.join(), /non-negative/)
    assert.match(
      validatePodSpec(minimalSpec({ budget: { credits: 1, currency: 9 } })).errors.join(),
      /budget.currency must be a string/,
    )
    assert.match(validatePodSpec(minimalSpec({ budget: 5 })).errors.join(), /budget must be an object/)
  })

  it('rejects unknown keys at every level rather than ignoring them', () => {
    assert.match(validatePodSpec(minimalSpec({ memMB: 64 })).errors.join(), /podspec: unknown key 'memMB'/)
    assert.match(
      validatePodSpec(minimalSpec({ run: { kind: 'skill', ref: 'x', cmd: 'y' } })).errors.join(),
      /run: unknown key 'cmd'/,
    )
    assert.match(
      validatePodSpec(minimalSpec({ limits: { memMB: 64 } })).errors.join(),
      /limits: unknown key 'memMB'/,
    )
    assert.match(
      validatePodSpec(minimalSpec({ budget: { credits: 1, token: 'x' } })).errors.join(),
      /budget: unknown key 'token'/,
    )
    assert.match(
      validatePodSpec(minimalSpec({ restart: { policy: 'always', jitter: 1 } })).errors.join(),
      /restart: unknown key 'jitter'/,
    )
  })

  it('omits optional sections that were absent from the normalized value', () => {
    const { value } = validatePodSpec(minimalSpec())
    assert.deepEqual(Object.keys(value).sort(), ['lane', 'name', 'restart', 'run'])
  })

  it('accumulates every error rather than stopping at the first', () => {
    const result = validatePodSpec({ name: '', run: { kind: 'nope' }, caps: 'x' })
    assert.equal(result.ok, false)
    assert.ok(result.errors.length >= 4, `expected several errors, got ${result.errors.length}`)
  })

  // -- links (issue #185 item 6) --------------------------------------------

  it('validates links.parent/hostedBy as non-empty strings and detachOnParentExit as boolean', () => {
    const ok = validatePodSpec(minimalSpec({
      links: { parent: 'mom', hostedBy: 'host-1', detachOnParentExit: true },
    }))
    assert.equal(ok.ok, true)
    assert.deepEqual(ok.value.links, { parent: 'mom', hostedBy: 'host-1', detachOnParentExit: true })

    assert.match(
      validatePodSpec(minimalSpec({ links: { parent: '' } })).errors.join(),
      /links.parent must be a non-empty string/,
    )
    assert.match(
      validatePodSpec(minimalSpec({ links: { hostedBy: 1 } })).errors.join(),
      /links.hostedBy must be a non-empty string/,
    )
    assert.match(
      validatePodSpec(minimalSpec({ links: { detachOnParentExit: 'yes' } })).errors.join(),
      /links.detachOnParentExit must be a boolean/,
    )
    assert.match(
      validatePodSpec(minimalSpec({ links: { bogus: 1 } })).errors.join(),
      /links: unknown key 'bogus'/,
    )
    assert.match(validatePodSpec(minimalSpec({ links: 'nope' })).errors.join(), /links must be an object/)
  })

  it('omits links from the normalized value when absent, and keeps only the given keys when present', () => {
    assert.equal('links' in validatePodSpec(minimalSpec()).value, false)
    const { value } = validatePodSpec(minimalSpec({ links: { parent: 'mom' } }))
    assert.deepEqual(value.links, { parent: 'mom' })
  })
})

// ---------------------------------------------------------------------------
// validateVerbRequest
// ---------------------------------------------------------------------------

describe('validateVerbRequest', () => {
  it('rejects an unknown verb', () => {
    const result = validateVerbRequest('reboot', {})
    assert.equal(result.ok, false)
    assert.deepEqual(result.errors, ["unknown verb 'reboot'"])
  })

  it('delegates spawn to validatePodSpec', () => {
    assert.equal(validateVerbRequest(POD_HOST_VERB.SPAWN, minimalSpec()).ok, true)
    assert.equal(validateVerbRequest(POD_HOST_VERB.SPAWN, { name: 'x' }).ok, false)
  })

  it('rejects a non-object payload for the non-spawn verbs', () => {
    const result = validateVerbRequest(POD_HOST_VERB.STATUS, 'alpha')
    assert.equal(result.ok, false)
    assert.match(result.errors.join(), /payload must be an object/)
  })

  it('validates status/snapshot/restore as name-only', () => {
    for (const verb of [POD_HOST_VERB.STATUS, POD_HOST_VERB.SNAPSHOT, POD_HOST_VERB.RESTORE]) {
      assert.deepEqual(validateVerbRequest(verb, { name: 'alpha' }), { ok: true, value: { name: 'alpha' } })
      assert.equal(validateVerbRequest(verb, {}).ok, false)
      assert.match(validateVerbRequest(verb, { name: 'a', force: true }).errors.join(), /unknown key 'force'/)
      assert.match(validateVerbRequest(verb, { name: 'bad name' }).errors.join(), /must match/)
    }
  })

  it('validates send with an optional to and a required payload', () => {
    assert.deepEqual(
      validateVerbRequest(POD_HOST_VERB.SEND, { name: 'alpha', payload: { hi: true } }),
      { ok: true, value: { name: 'alpha', payload: { hi: true } } },
    )
    assert.deepEqual(
      validateVerbRequest(POD_HOST_VERB.SEND, { name: 'alpha', to: 'peer-1', payload: null }).value,
      { name: 'alpha', payload: null, to: 'peer-1' },
    )
    assert.match(validateVerbRequest(POD_HOST_VERB.SEND, { name: 'alpha' }).errors.join(), /payload is required/)
    assert.match(
      validateVerbRequest(POD_HOST_VERB.SEND, { name: 'alpha', to: '', payload: 1 }).errors.join(),
      /to must be a non-empty string/,
    )
  })

  it('normalizes exec command to an argv array without shell-splitting a string', () => {
    assert.deepEqual(
      validateVerbRequest(POD_HOST_VERB.EXEC, { name: 'alpha', command: ['ls', '-la'] }).value,
      { name: 'alpha', command: ['ls', '-la'] },
    )
    assert.deepEqual(
      validateVerbRequest(POD_HOST_VERB.EXEC, { name: 'alpha', command: 'ls -la' }).value,
      { name: 'alpha', command: ['ls -la'] },
    )
    assert.deepEqual(
      validateVerbRequest(POD_HOST_VERB.EXEC, { name: 'alpha', command: 'ls', timeoutMs: 50 }).value,
      { name: 'alpha', command: ['ls'], timeoutMs: 50 },
    )
  })

  it('rejects malformed exec commands and timeouts', () => {
    assert.match(validateVerbRequest(POD_HOST_VERB.EXEC, { name: 'a' }).errors.join(), /command is required/)
    assert.match(validateVerbRequest(POD_HOST_VERB.EXEC, { name: 'a', command: '' }).errors.join(), /non-empty/)
    assert.match(validateVerbRequest(POD_HOST_VERB.EXEC, { name: 'a', command: [] }).errors.join(), /non-empty/)
    assert.match(
      validateVerbRequest(POD_HOST_VERB.EXEC, { name: 'a', command: ['ls', 7] }).errors.join(),
      /command\[1\] must be a non-empty string/,
    )
    assert.match(
      validateVerbRequest(POD_HOST_VERB.EXEC, { name: 'a', command: ['ls'], timeoutMs: -5 }).errors.join(),
      /timeoutMs must be a positive/,
    )
  })

  it('defaults drain cascade to false and rejects a non-boolean', () => {
    assert.deepEqual(
      validateVerbRequest(POD_HOST_VERB.DRAIN, { name: 'alpha' }).value,
      { name: 'alpha', cascade: false },
    )
    assert.deepEqual(
      validateVerbRequest(POD_HOST_VERB.DRAIN, { name: 'alpha', cascade: true }).value,
      { name: 'alpha', cascade: true },
    )
    assert.match(
      validateVerbRequest(POD_HOST_VERB.DRAIN, { name: 'alpha', cascade: 'yes' }).errors.join(),
      /cascade must be a boolean/,
    )
  })

  it('accepts an empty list payload and rejects any key on it', () => {
    assert.deepEqual(validateVerbRequest(POD_HOST_VERB.LIST), { ok: true, value: {} })
    assert.deepEqual(validateVerbRequest(POD_HOST_VERB.LIST, {}), { ok: true, value: {} })
    assert.match(validateVerbRequest(POD_HOST_VERB.LIST, { all: true }).errors.join(), /unknown key 'all'/)
  })
})

// ---------------------------------------------------------------------------
// Wire messages
// ---------------------------------------------------------------------------

describe('wire messages', () => {
  it('builds a request with a generated, unique requestId', () => {
    const a = createHostRequest(POD_HOST_VERB.LIST)
    const b = createHostRequest(POD_HOST_VERB.LIST)
    assert.equal(a.type, POD_HOST_REQUEST)
    assert.equal(a.verb, 'list')
    assert.deepEqual(a.payload, {})
    assert.equal(typeof a.ts, 'number')
    assert.ok(a.requestId)
    assert.notEqual(a.requestId, b.requestId)
  })

  it('honours a caller-supplied requestId', () => {
    const req = createHostRequest(POD_HOST_VERB.STATUS, { name: 'alpha' }, { requestId: 'r-1' })
    assert.equal(req.requestId, 'r-1')
    assert.deepEqual(req.payload, { name: 'alpha' })
  })

  it('round-trips a request through JSON unchanged', () => {
    const req = createHostRequest(POD_HOST_VERB.SPAWN, minimalSpec(), { requestId: 'r-2' })
    assert.deepEqual(JSON.parse(JSON.stringify(req)), req)
  })

  it('builds an ok response with null error', () => {
    const res = createHostResponse('r-1', { ok: true, result: { state: 'registered' } })
    assert.equal(res.type, POD_HOST_RESPONSE)
    assert.equal(res.ok, true)
    assert.deepEqual(res.result, { state: 'registered' })
    assert.equal(res.error, null)
    assert.deepEqual(JSON.parse(JSON.stringify(res)), res)
  })

  it('builds an error response carrying only code and message', () => {
    const err = new PodHostDriverError(POD_HOST_ERROR.ELANE, 'nope', { lane: 'isolate' })
    const res = createHostResponse('r-1', { ok: false, error: err })
    assert.equal(res.ok, false)
    assert.equal(res.result, null)
    assert.deepEqual(res.error, { code: 'ELANE', message: 'nope' })
    assert.equal(res.error.details, undefined)
  })

  it('coerces a missing ok to false', () => {
    assert.equal(createHostResponse('r-1').ok, false)
  })

  it('builds events of each kind', () => {
    for (const kind of Object.values(POD_HOST_EVENT_KIND)) {
      const event = createHostEvent(kind, { name: 'alpha' })
      assert.equal(event.type, POD_HOST_EVENT)
      assert.equal(event.kind, kind)
      assert.deepEqual(event.data, { name: 'alpha' })
      assert.deepEqual(JSON.parse(JSON.stringify(event)), event)
    }
    assert.deepEqual(createHostEvent(POD_HOST_EVENT_KIND.LOG).data, {})
  })
})

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

describe('PodHostDriverError', () => {
  it('carries a code, details and a {code,message} JSON shape', () => {
    const err = new PodHostDriverError(POD_HOST_ERROR.ENOENT, 'missing', { name: 'x' })
    assert.ok(err instanceof Error)
    assert.equal(err.name, 'PodHostDriverError')
    assert.equal(err.code, 'ENOENT')
    assert.deepEqual(err.details, { name: 'x' })
    assert.deepEqual(err.toJSON(), { code: 'ENOENT', message: 'missing' })
  })

  it('rebuilds from a wire error and passes instances through', () => {
    const rebuilt = PodHostDriverError.from({ code: 'EACCES', message: 'denied' })
    assert.ok(rebuilt instanceof PodHostDriverError)
    assert.equal(rebuilt.code, 'EACCES')
    const original = new PodHostDriverError('EBUSY', 'busy')
    assert.equal(PodHostDriverError.from(original), original)
    assert.equal(PodHostDriverError.from('boom').code, 'EINVAL')
  })
})

describe('createUnsupportedDriverMethod', () => {
  it('throws ELANE when the lane structurally cannot do the verb', async () => {
    const method = createUnsupportedDriverMethod(POD_HOST_VERB.EXEC, POD_LANE.ISOLATE)
    await assert.rejects(method(), (err) => {
      assert.equal(err.code, POD_HOST_ERROR.ELANE)
      assert.match(err.message, /lane 'isolate' cannot 'exec'/)
      return true
    })
  })

  it('throws ENOTSUP when the lane could, but this driver did not implement it', async () => {
    const method = createUnsupportedDriverMethod(POD_HOST_VERB.SNAPSHOT, POD_LANE.MICROVM)
    await assert.rejects(method(), (err) => err.code === POD_HOST_ERROR.ENOTSUP)
  })

  it('throws ENOTSUP when no lane is given, and honours overrides', async () => {
    await assert.rejects(createUnsupportedDriverMethod('exec')(), (err) => err.code === POD_HOST_ERROR.ENOTSUP)
    await assert.rejects(
      createUnsupportedDriverMethod('exec', POD_LANE.NODE, { code: 'EBUSY', message: 'later' })(),
      (err) => err.code === 'EBUSY' && err.message === 'later',
    )
  })
})

// ---------------------------------------------------------------------------
// InMemoryPodHostDriver
// ---------------------------------------------------------------------------

describe('InMemoryPodHostDriver', () => {
  it("defaults to the node lane with all eight verbs", () => {
    const driver = new InMemoryPodHostDriver()
    assert.equal(driver.lane, POD_LANE.NODE)
    assert.deepEqual(driver.capabilities().verbs.sort(), [...POD_HOST_VERBS].sort())
  })

  it('rejects an unknown lane at construction', () => {
    assert.throws(() => new InMemoryPodHostDriver({ lane: 'gvisor' }), /unknown lane/)
  })

  it('narrows, but never widens, the lane verb set', () => {
    const narrowed = new InMemoryPodHostDriver({ lane: POD_LANE.NODE, verbs: ['spawn', 'list'] })
    assert.deepEqual(narrowed.capabilities().verbs, ['spawn', 'list'])
    const widened = new InMemoryPodHostDriver({ lane: POD_LANE.ISOLATE, verbs: [...POD_HOST_VERBS] })
    assert.equal(widened.capabilities().verbs.includes('exec'), false)
  })

  it('runs a pod through the full lifecycle: spawn -> exec -> snapshot -> restore -> drain -> gone', async () => {
    const driver = new InMemoryPodHostDriver({ lane: POD_LANE.MICROVM })
    /** @type {object[]} */
    const events = []
    driver.onEvent((event) => events.push(event))

    const spawned = await driver.spawn({ name: 'alpha', run: { kind: 'command', ref: '/bin/echo' } })
    assert.equal(spawned.state, POD_LIFECYCLE.REGISTERED)
    assert.equal(spawned.lane, POD_LANE.MICROVM)
    assert.equal(spawned.spec.restart.policy, 'never')

    const sent = await driver.send('alpha', { payload: { hello: true } })
    assert.deepEqual(sent, { delivered: true, inbox: 1 })

    const execResult = await driver.exec('alpha', ['echo', 'hi'])
    assert.deepEqual(execResult, { stdout: 'echo hi', stderr: '', code: 0 })
    assert.equal((await driver.status('alpha')).state, POD_LIFECYCLE.REGISTERED)

    assert.equal((await driver.snapshot('alpha')).state, POD_LIFECYCLE.SNAPSHOTTED)
    assert.equal((await driver.restore('alpha')).state, POD_LIFECYCLE.REGISTERED)
    assert.equal((await driver.drain('alpha')).state, POD_LIFECYCLE.GONE)
    assert.equal((await driver.status('alpha')).state, POD_LIFECYCLE.GONE)

    const lifecycle = events
      .filter((event) => event.kind === POD_HOST_EVENT_KIND.LIFECYCLE)
      .map((event) => `${event.data.from}->${event.data.to}`)
    assert.deepEqual(lifecycle, [
      'cold->booting', 'booting->registered',
      'registered->serving', 'serving->registered',
      'registered->paused', 'paused->snapshotted',
      'snapshotted->restoring', 'restoring->registered',
      'registered->draining', 'draining->gone',
    ])
    assert.equal(events.filter((event) => event.kind === POD_HOST_EVENT_KIND.LOG).length, 1)
    assert.equal(events.filter((event) => event.kind === POD_HOST_EVENT_KIND.EXIT).length, 1)
  })

  it('uses an injected exec fn and passes it the argv plus context', async () => {
    /** @type {object[]} */
    const calls = []
    const driver = new InMemoryPodHostDriver({
      exec: async (argv, ctx) => {
        calls.push({ argv, ctx })
        return { stdout: '', stderr: 'nope', code: 7 }
      },
    })
    await driver.spawn(minimalSpec({ lane: POD_LANE.NODE }))
    const result = await driver.exec('alpha', ['false'], { timeoutMs: 20 })
    assert.deepEqual(result, { stdout: '', stderr: 'nope', code: 7 })
    assert.deepEqual(calls, [{ argv: ['false'], ctx: { name: 'alpha', timeoutMs: 20 } }])
  })

  it('returns the pod to registered even when exec rejects', async () => {
    const driver = new InMemoryPodHostDriver({ exec: async () => { throw new Error('boom') } })
    await driver.spawn(minimalSpec({ lane: POD_LANE.NODE }))
    await assert.rejects(driver.exec('alpha', ['x']), /boom/)
    assert.equal((await driver.status('alpha')).state, POD_LIFECYCLE.REGISTERED)
  })

  it('rejects an invalid podspec with EINVAL listing every error', async () => {
    const driver = new InMemoryPodHostDriver()
    await assert.rejects(driver.spawn({ name: 'bad name' }), (err) => {
      assert.equal(err.code, POD_HOST_ERROR.EINVAL)
      assert.ok(Array.isArray(err.details.errors))
      return true
    })
  })

  it('rejects a duplicate live name with EEXIST but reuses a tombstone', async () => {
    const driver = new InMemoryPodHostDriver()
    await driver.spawn(minimalSpec({ lane: POD_LANE.NODE }))
    await assert.rejects(
      driver.spawn(minimalSpec({ lane: POD_LANE.NODE })),
      (err) => err.code === POD_HOST_ERROR.EEXIST,
    )
    await driver.drain('alpha')
    const respawned = await driver.spawn(minimalSpec({ lane: POD_LANE.NODE }))
    assert.equal(respawned.state, POD_LIFECYCLE.REGISTERED)
  })

  it('rejects unknown and tombstoned pods with ENOENT', async () => {
    const driver = new InMemoryPodHostDriver()
    await assert.rejects(driver.status('ghost'), (err) => err.code === POD_HOST_ERROR.ENOENT)
    await driver.spawn(minimalSpec({ lane: POD_LANE.NODE }))
    await driver.drain('alpha')
    await assert.rejects(driver.exec('alpha', ['ls']), (err) => err.code === POD_HOST_ERROR.ENOENT)
    await assert.rejects(driver.send('alpha', { payload: 1 }), (err) => err.code === POD_HOST_ERROR.ENOENT)
  })

  it('rejects an illegal lifecycle transition with EBUSY', async () => {
    const driver = new InMemoryPodHostDriver()
    await driver.spawn(minimalSpec({ lane: POD_LANE.NODE }))
    await assert.rejects(driver.restore('alpha'), (err) => {
      assert.equal(err.code, POD_HOST_ERROR.EBUSY)
      assert.match(err.message, /registered -> restoring/)
      return true
    })
  })

  it('refuses exec/snapshot/restore with ELANE on the isolate lane', async () => {
    const driver = new InMemoryPodHostDriver({ lane: POD_LANE.ISOLATE })
    await driver.spawn(minimalSpec())
    for (const call of [
      () => driver.exec('alpha', ['ls']),
      () => driver.snapshot('alpha'),
      () => driver.restore('alpha'),
    ]) {
      await assert.rejects(call(), (err) => {
        assert.equal(err.code, POD_HOST_ERROR.ELANE)
        assert.match(err.message, /lane 'isolate' cannot/)
        return true
      })
    }
    // ...but the lane-compatible verbs all still work.
    assert.equal((await driver.status('alpha')).lane, POD_LANE.ISOLATE)
    assert.equal((await driver.drain('alpha')).state, POD_LIFECYCLE.GONE)
  })

  it('refuses a narrowed-away verb with ENOTSUP, not ELANE', async () => {
    const driver = new InMemoryPodHostDriver({ lane: POD_LANE.NODE, verbs: ['spawn', 'status', 'list'] })
    await driver.spawn(minimalSpec({ lane: POD_LANE.NODE }))
    await assert.rejects(driver.exec('alpha', ['ls']), (err) => err.code === POD_HOST_ERROR.ENOTSUP)
  })

  it('lists every tracked pod including tombstones', async () => {
    const driver = new InMemoryPodHostDriver()
    await driver.spawn({ name: 'alpha', lane: 'node', run: { kind: 'skill', ref: 'a' } })
    await driver.spawn({ name: 'beta', lane: 'node', run: { kind: 'skill', ref: 'b' } })
    await driver.drain('beta')
    const list = await driver.list()
    assert.deepEqual(list.map((pod) => [pod.name, pod.state]), [['alpha', 'registered'], ['beta', 'gone']])
  })

  it('records the drain cascade flag on the exit event', async () => {
    const driver = new InMemoryPodHostDriver()
    /** @type {object[]} */
    const exits = []
    driver.onEvent((event) => { if (event.kind === POD_HOST_EVENT_KIND.EXIT) exits.push(event.data) })
    await driver.spawn(minimalSpec({ lane: POD_LANE.NODE }))
    await driver.drain('alpha', { cascade: true })
    assert.equal(exits[0].cascade, true)
  })

  it("drain's exit event carries reason 'drained' and restartable: false", async () => {
    const driver = new InMemoryPodHostDriver()
    /** @type {object[]} */
    const exits = []
    driver.onEvent((event) => { if (event.kind === POD_HOST_EVENT_KIND.EXIT) exits.push(event.data) })
    await driver.spawn(minimalSpec({ lane: POD_LANE.NODE }))
    await driver.drain('alpha')
    assert.deepEqual(
      { reason: exits[0].reason, restartable: exits[0].restartable },
      { reason: 'drained', restartable: false },
    )
  })

  it("crash() moves a live pod to gone and emits an exit event with reason 'crashed', restartable: true", async () => {
    const driver = new InMemoryPodHostDriver()
    /** @type {object[]} */
    const events = []
    driver.onEvent((event) => events.push(event))
    await driver.spawn(minimalSpec({ lane: POD_LANE.NODE }))

    const crashed = await driver.crash('alpha', { code: 17 })
    assert.equal(crashed.state, POD_LIFECYCLE.GONE)
    assert.equal((await driver.status('alpha')).state, POD_LIFECYCLE.GONE)

    const exits = events.filter((e) => e.kind === POD_HOST_EVENT_KIND.EXIT)
    assert.equal(exits.length, 1)
    assert.deepEqual(exits[0].data, {
      name: 'alpha', lane: POD_LANE.NODE, code: 17, reason: 'crashed', restartable: true,
    })

    const lifecycle = events
      .filter((e) => e.kind === POD_HOST_EVENT_KIND.LIFECYCLE)
      .map((e) => `${e.data.from}->${e.data.to}`)
    assert.deepEqual(lifecycle, ['cold->booting', 'booting->registered', 'registered->gone'])
  })

  it('crash() defaults code to 1 and rejects an unknown or already-gone pod with ENOENT', async () => {
    const driver = new InMemoryPodHostDriver()
    await assert.rejects(driver.crash('ghost'), (err) => err.code === POD_HOST_ERROR.ENOENT)

    await driver.spawn(minimalSpec({ lane: POD_LANE.NODE }))
    /** @type {object[]} */
    const exits = []
    driver.onEvent((event) => { if (event.kind === POD_HOST_EVENT_KIND.EXIT) exits.push(event.data) })
    await driver.crash('alpha')
    assert.equal(exits[0].code, 1)
    await assert.rejects(driver.crash('alpha'), (err) => err.code === POD_HOST_ERROR.ENOENT)
  })

  it('isolates a throwing event subscriber and supports unsubscribe', async () => {
    const driver = new InMemoryPodHostDriver()
    /** @type {object[]} */
    const seen = []
    driver.onEvent(() => { throw new Error('subscriber blew up') })
    const off = driver.onEvent((event) => seen.push(event))
    assert.equal(typeof driver.onEvent('not a function'), 'function')
    await driver.spawn(minimalSpec({ lane: POD_LANE.NODE }))
    assert.ok(seen.length > 0)
    off()
    const before = seen.length
    await driver.drain('alpha')
    assert.equal(seen.length, before)
  })
})
