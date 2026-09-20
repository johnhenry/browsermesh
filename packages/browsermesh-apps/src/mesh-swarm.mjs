/**
 * mesh-swarm.mjs -- wires `@johnhenry/browsermesh-discovery`'s `swarm.mjs`
 * (issue #88): a complete, previously-unconstructed SWIM failure-detection +
 * leader-election + task-distribution stack (`SwimMembership`,
 * `SwarmCoordinator`, wrapping `LeaderElection`/`TaskDistributor`
 * internally). Despite importing from the shared `MESH_TYPE` wire registry,
 * nothing anywhere constructed any of these classes before this file -- see
 * the issue for the full audit trail. Follows the exact `MeshService`
 * `attach(peerNode, ctx)` convention every other service in this package
 * uses (`peer-routing.mjs`'s `createMeshRoutingService()` is the closest,
 * most recent template).
 *
 * ---------------------------------------------------------------------------
 * SWIM BRIDGE -- mechanical, mirrors `peer-routing.mjs`'s `forwardFn`/
 * `handleRoutedMessage` pattern exactly: `SwimMembership`'s only network
 * side effect is `sendFn(targetId, msg)`; inbound wire traffic is fed in via
 * `handleMessage(fromId, msg)`. One wrinkle `peer-routing.mjs` didn't have to
 * deal with: `SwimMembership`'s own wire messages ALREADY carry a `type`
 * field (`SWIM_PING`/`SWIM_ACK`/etc, numeric), and `ctx.sendTo(pubKey, type,
 * payload)` builds `{ type, ...payload }` -- spreading `payload` LAST, so a
 * bare `msg` passed as `payload` would silently overwrite the outer envelope
 * `type` (a string, what `ctx.onIncomingData()` filters on) with SWIM's own
 * numeric `type`, breaking dispatch entirely. This file nests SWIM's message
 * under its own `msg` key (`ctx.sendTo(targetId, swimEnvelopeType, { msg })`)
 * to avoid the collision, unwrapping on receipt (`envelope.msg`).
 *
 * `swim.start()` is called here (SwimMembership itself never starts its own
 * ping loop); `swim.stop()` runs in `teardown()` -- this clears SWIM's
 * internal ping/suspect timers, mirroring how issue #110's keepalive
 * teardown was verified to leave no leaked timers.
 *
 * ---------------------------------------------------------------------------
 * SINGLE-SLOT CALLBACK COMPOSITION -- `SwimMembership.onJoin`/`onDead`/
 * `onSuspect`/`onLeave` are plain properties, not a real emitter (one
 * listener each, last write wins). `new SwarmCoordinator(localPodId, {
 * swim })` ALREADY assigns `swim.onJoin`/`swim.onDead` in its own
 * constructor (to call `this.join(podId)`/`this.leave(podId)`, making
 * membership genuinely SWIM-driven) -- so this file must WRAP those two,
 * not overwrite them, or `SwarmCoordinator`'s own membership wiring breaks
 * silently. `onSuspect` is untouched by `SwarmCoordinator` and is set
 * directly.
 *
 * `onLeave`, however, ALSO needs to drive `coordinator.leave()`, even
 * though `SwarmCoordinator`'s constructor never wires it: a 'left' state
 * can reach a node two ways -- (a) its OWN local dead-detection
 * (`#onSuspectTimeout` sets 'dead', fires `onDead`, and `coordinator
 * .leave()` -- invoked by the wrapped `onDead` -- itself calls
 * `swim.removeMember()`, which unconditionally overwrites state to 'left'
 * and fires `onLeave` too, so BOTH `swarm:member-dead` and
 * `swarm:member-left` fire for that node); or (b) purely via GOSSIP, when
 * another peer's already-'left' update about a THIRD node arrives here
 * first -- `SwimMembership`'s own `#fireStateCallbacks` fires only the
 * callback matching the state it just applied, so a gossip-received 'left'
 * fires `onLeave` alone, with `onDead` never called on THIS node's view at
 * all. Without `onLeave` also driving `coordinator.leave()`, path (b) would
 * leave that podId in this node's own election candidate pool and
 * distributor member list forever (confirmed by testing: without this, two
 * survivors could permanently disagree on whether a dead leader was still a
 * candidate). Driving `coordinator.leave()` from `onLeave` reintroduces the
 * same recursion hazard one level deeper, though: `coordinator.leave()`
 * calls `swim.removeMember()`, which re-fires `onLeave` unconditionally (no
 * "already left" guard of its own) -- so `onLeave` -> `coordinator.leave()`
 * -> `removeMember()` -> `onLeave` again would recurse forever without a
 * guard. `leaveHandled` (a `Set`, below) is that guard: whichever of
 * `onDead`/`onLeave`/the explicit `'leave'` wire message (`handleLeave()`)
 * observes a given podId's departure FIRST performs the real
 * `coordinator.leave()` and marks it done; every later call for the same
 * podId becomes a no-op, while `ctx.emit()` still fires exactly once per
 * real transition from whichever wrapper actually ran the logic. Cleared on
 * rejoin (`onJoin`) so a podId that leaves and later rejoins is handled
 * again correctly.
 *
 * ---------------------------------------------------------------------------
 * LEADER ELECTION HEARTBEAT PUMP -- genuinely new logic (nothing in
 * `swarm.mjs` broadcasts a heartbeat or triggers re-election on its own;
 * `LeaderElection.receiveHeartbeat()` is a plain method with no send side and
 * `elect()` is never called automatically). Every `heartbeatMs` (default
 * 5000, matching `LeaderElection`'s own default `heartbeatMs` so the
 * broadcast cadence and its `electionTimeoutMs`-based staleness math line
 * up) this node:
 *
 *   1. Refreshes its OWN heartbeat timestamp locally (`election
 *      .receiveHeartbeat(localPodId, now)`) -- without this, a node that
 *      becomes leader would only ever have the construction-time timestamp
 *      for itself and could spuriously self-declare stale.
 *   2. Broadcasts `{ from, timestamp, meshType: SWARM_HEARTBEAT }` to every
 *      OTHER member of `coordinator.listMembers()` via
 *      `ctx.sendTo(memberId, 'swarm-heartbeat', ...)` -- giving
 *      `MESH_TYPE.SWARM_HEARTBEAT` (previously an unused re-export) its
 *      first real use. Every member broadcasts, not just the leader -- the
 *      only heartbeat that actually matters for `checkLeaderAlive()` is the
 *      CURRENT leader's, but broadcasting unconditionally means a node that
 *      later becomes leader has already been priming every other member's
 *      `#heartbeats` map, and it keeps the wire protocol symmetric/simple.
 *   3. Unconditionally calls `election.elect()` -- the lowest-lexicographic-
 *      podId deterministic algorithm already in `LeaderElection` -- EVERY
 *      tick, not only when `checkLeaderAlive()` reports staleness. This is
 *      deliberate, not an oversight: `elect()` is a pure, idempotent
 *      recomputation over the CURRENT candidate set (no side effect beyond
 *      setting `#leader`), so calling it every tick is cheap and safe, and
 *      it is what actually makes independently-bootstrapped nodes converge.
 *      A node with no peers yet necessarily elects ITSELF on its very first
 *      tick (the only candidate it knows about); gating re-election behind
 *      "is the current leader stale" would leave that node stuck governing
 *      itself forever once its own heartbeat keeps refreshing (see point 1),
 *      even after real peers join and a lexicographically-lower candidate
 *      becomes known. Always recomputing self-heals that: the very next
 *      tick after membership changes, every node's `elect()` converges on
 *      the same answer, because `LeaderElection.elect()` depends only on
 *      the candidate SET, which is kept accurate by `coordinator.join()`/
 *      `coordinator.leave()` (called directly, and via the wrapped SWIM
 *      callbacks above). This composes correctly with SWIM for the "leader
 *      goes silent" case too: a genuinely dead leader is removed from the
 *      candidate pool by SWIM's own `suspectTimeoutMs` cascade (`onDead` ->
 *      wrapped -> `coordinator.leave()` -> `election.removeCandidate()`),
 *      so the very next tick's `elect()` picks a different, live leader.
 *      `election.checkLeaderAlive()` is still exposed on this file's `api`
 *      for a caller that wants to ask "is the leader I know about still
 *      heartbeating," but it no longer gates the election decision itself.
 *      `elect()` never throws in practice (the local pod is always its own
 *      candidate), but a throw is still guarded so it can never kill the
 *      interval.
 *
 * `heartbeatTick()` also runs once, synchronously, at `attach()` time (not
 * waiting a full `heartbeatMs` for the very first election), and its
 * `setInterval` handle is cleared in `teardown()`.
 *
 * ---------------------------------------------------------------------------
 * SWARM_JOIN / SWARM_LEAVE -- REAL, DELIBERATE USE (not redundant with
 * SWIM). SWIM's own protocol assumes membership is already decided
 * elsewhere (`addMember()`/`removeMember()` are plain local calls); it has
 * no ADMISSION-CONTROL concept of its own -- nothing stops any podId from
 * being silently added. `SWARM_JOIN` backs a real, authorized handshake
 * layered ON TOP of SWIM for exactly that gap: a remote peer sends a
 * `'join-request'` on `membershipEnvelopeType` (default `'swarm-membership'`,
 * carrying `meshType: SWARM_JOIN` in spirit -- see `accessResource`/`'join'`
 * below), this node gates it via `ctx.registry.checkAccess(fromPubKey,
 * accessResource, 'join')`, and only on success calls `swim.addMember()`
 * (which cascades into `coordinator.join()` via the wrapped callback above)
 * and replies `'join-response'`. `SWARM_LEAVE` backs a real, COURTESY
 * departure announcement, semantically distinct from SWIM's own dead-via-
 * timeout detection (`suspectTimeoutMs` later): a peer that is shutting down
 * cleanly can tell everyone immediately via `announceLeave()` rather than
 * making every other member wait out the full suspect/dead cascade. No
 * separate `checkAccess()` gate is needed for an inbound `'leave'` message:
 * the podId being removed is always the network-authenticated `fromPubKey`
 * itself (never a value the sender supplies in the payload), so a peer can
 * only ever announce its OWN departure -- there is no spoofing surface here
 * the way there is for `'join-request'`/`'submit-task'`.
 *
 * ---------------------------------------------------------------------------
 * SWARM_TASK_ASSIGN -- REAL NOTIFICATION, NOT LEFT AS AN UNUSED CONSTANT.
 * `SwarmCoordinator.submitTask()`/`TaskDistributor.distribute()` are pure,
 * synchronous, in-memory bookkeeping -- deciding WHO a task is assigned to,
 * with no way for the assignee to ever find out short of being told.
 * Leaving that silent would make `submitTask()` nearly useless for a real
 * multi-peer swarm (the assignee has no queue to poll and no event to
 * subscribe to), so this file's `api.submitTask()` wraps
 * `coordinator.submitTask()` and, for every assignee that isn't the local
 * pod, fires `ctx.sendTo(podId, 'swarm-task', { kind: 'assign', meshType:
 * SWARM_TASK_ASSIGN, task: task.toJSON() })` -- fire-and-forget (matching
 * `coordinator.submitTask()`'s own synchronous, non-blocking contract; a
 * slow/unreachable assignee doesn't block the submitter). The receiving
 * side stores the notification in a small local `assignedTasks` map
 * (`api.listAssignedTasks()`/`api.getAssignedTask()`) and emits
 * `swarm:task-received` -- deliberately NOT written into the receiver's own
 * `SwarmCoordinator#tasks` map, since that map is scoped to tasks THIS
 * coordinator itself submitted/owns, and (per the issue's own grounded
 * facts) neither `SwarmCoordinator` nor `SwimMembership` execute a task --
 * there is no "run untrusted code" boundary anywhere in `swarm.mjs`, so this
 * file adds none either; a caller (an execution engine one layer up) is
 * expected to consume `swarm:task-received`/`listAssignedTasks()` and decide
 * what "running" a task even means, exactly the same restraint
 * `mesh-compute.mjs`'s `executeFn` and `mesh-verification.mjs`'s `executeFn`
 * already show for their own execution boundaries.
 *
 * `api.requestSubmitTask(targetPodId, {...})` is the complementary
 * PEER-INITIATED direction: a node without swarm-distribution rights of its
 * own (or that just wants a specific peer's swarm view to do the
 * distributing) asks that peer to submit a task on its behalf, over a real
 * `'submit-request'`/`'submit-response'` round trip on `taskEnvelopeType`
 * (default `'swarm-task'`). Inbound `'submit-request'` is gated via
 * `ctx.registry.checkAccess(fromPubKey, accessResource, 'submit-task')`,
 * mirroring `mesh-compute.mjs`'s `'compute-request'` gate: an explicit
 * `{error}` response on denial (not a silent drop), since the requester's
 * promise is already open and waiting.
 *
 * ---------------------------------------------------------------------------
 * Observability events (`ctx.emit()`, see `mesh-service.mjs`'s convention):
 *
 *   - `swarm:member-joined`/`swarm:member-suspect`/`swarm:member-dead`/
 *     `swarm:member-left` `{podId}` -- bridged straight from `SwimMembership`'s
 *     own `onJoin`/`onSuspect`/`onDead`/`onLeave` (composed, not overwritten
 *     -- see above).
 *   - `swarm:leader-elected` `{leader, previousLeader}` -- fired only when
 *     `election.elect()` actually changes the leader.
 *   - `swarm:join-request-granted`/`swarm:join-request-denied` `{from,
 *     reason?}` -- an inbound `'join-request'`'s outcome.
 *   - `swarm:submit-task-denied` `{from, reason}` -- an inbound
 *     `'submit-request'` rejected before ever calling `submitTask()`.
 *   - `swarm:task-assigned` `{podId, taskId, task}` -- this node, as
 *     submitter, notified a remote assignee.
 *   - `swarm:task-received` `{from, task}` -- this node, as assignee,
 *     received a task notification from a remote submitter.
 *
 * No browser-only imports at module level.
 *
 * `@johnhenry/browsermesh-discovery` (an optional peerDependency) is
 * imported eagerly here, deliberately -- see the CHANGELOG entry
 * documenting the sibling fix in other files of this package.
 * `SwimMembership`/`SwarmCoordinator` are both constructed synchronously
 * inside this service's `attach()`, whose synchronous-return contract is a
 * hard, repo-wide convention (`mesh-service.mjs`'s `attachService()`,
 * relied on -- without `await` -- throughout `mesh-bootstrap.mjs`); making
 * `attach()` async to lazy-load these would break that convention, not
 * attempted here.
 */

import {
  SwarmCoordinator,
  SwimMembership,
  SWARM_JOIN,
  SWARM_LEAVE,
  SWARM_HEARTBEAT,
  SWARM_TASK_ASSIGN,
} from '@johnhenry/browsermesh-discovery'

const DEFAULT_SWIM_ENVELOPE_TYPE = 'swarm-swim'
const DEFAULT_HEARTBEAT_ENVELOPE_TYPE = 'swarm-heartbeat'
const DEFAULT_MEMBERSHIP_ENVELOPE_TYPE = 'swarm-membership'
const DEFAULT_TASK_ENVELOPE_TYPE = 'swarm-task'
/** Matches `LeaderElection`'s own default `heartbeatMs` -- see module doc comment. */
const DEFAULT_HEARTBEAT_MS = 5000
/** Matches `LeaderElection`'s own default `electionTimeoutMs`. */
const DEFAULT_ELECTION_TIMEOUT_MS = 15000
/** Default `resource` passed to `ctx.registry.checkAccess(fromPubKey, resource, action)` for both gated actions (`'join'`/`'submit-task'`). */
const DEFAULT_ACCESS_RESOURCE = 'swarm'
/** How long `requestJoin()`/`requestSubmitTask()` wait for a matching response before giving up. */
const DEFAULT_REQUEST_TIMEOUT_MS = 10000

/**
 * Build a `MeshService` descriptor (`mesh-service.mjs`, Phase C) wrapping
 * `SwarmCoordinator` + an internally-constructed `SwimMembership`. See this
 * file's module doc comment for the full design (SWIM bridge, single-slot
 * callback composition, heartbeat pump, SWARM_JOIN/LEAVE/TASK_ASSIGN use).
 *
 * @param {object} [opts]
 * @param {number} [opts.heartbeatMs=5000] - Broadcast interval for this
 *   node's own leadership heartbeat, and the value passed straight through
 *   to `SwarmCoordinator`'s (and therefore `LeaderElection`'s) own
 *   `heartbeatMs` constructor option.
 * @param {number} [opts.electionTimeoutMs=15000] - Passed straight through
 *   to `SwarmCoordinator`'s (and therefore `LeaderElection`'s) own
 *   `electionTimeoutMs` constructor option.
 * @param {object} [opts.swimOptions] - Passed straight through to
 *   `new SwimMembership()` (`pingIntervalMs`/`pingTimeoutMs`/
 *   `suspectTimeoutMs`/`indirectPingCount`/`nowFn`). `localId`/`sendFn` are
 *   always supplied by this file and cannot be overridden here.
 * @param {string} [opts.swimEnvelopeType='swarm-swim']
 * @param {string} [opts.heartbeatEnvelopeType='swarm-heartbeat']
 * @param {string} [opts.membershipEnvelopeType='swarm-membership']
 * @param {string} [opts.taskEnvelopeType='swarm-task']
 * @param {string} [opts.accessResource='swarm'] - `resource` passed to
 *   `ctx.registry.checkAccess()` for both inbound `'join-request'`
 *   (action `'join'`) and inbound `'submit-request'` (action `'submit-task'`).
 * @param {number} [opts.requestTimeoutMs=10000] - Default timeout for
 *   `requestJoin()`/`requestSubmitTask()`.
 * @param {Function} [opts.onLog]
 * @returns {import('./mesh-service.mjs').MeshService}
 */
export function createSwarmService(opts = {}) {
  const {
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    electionTimeoutMs = DEFAULT_ELECTION_TIMEOUT_MS,
    swimOptions,
    swimEnvelopeType = DEFAULT_SWIM_ENVELOPE_TYPE,
    heartbeatEnvelopeType = DEFAULT_HEARTBEAT_ENVELOPE_TYPE,
    membershipEnvelopeType = DEFAULT_MEMBERSHIP_ENVELOPE_TYPE,
    taskEnvelopeType = DEFAULT_TASK_ENVELOPE_TYPE,
    accessResource = DEFAULT_ACCESS_RESOURCE,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    onLog,
  } = opts
  const log = onLog || (() => {})

  return {
    name: 'swarm',

    attach(peerNode, ctx) {
      const localPodId = peerNode.podId

      // -----------------------------------------------------------------
      // SwimMembership -- see module doc comment's "SWIM BRIDGE" section.
      // -----------------------------------------------------------------
      const swim = new SwimMembership({
        ...swimOptions,
        localId: localPodId,
        sendFn: (targetId, msg) => {
          ctx.sendTo(targetId, swimEnvelopeType, { msg }).catch((err) => {
            log('mesh-swarm:swim-send-failed', { targetId, error: err?.message || String(err) })
          })
        },
      })

      // -----------------------------------------------------------------
      // SwarmCoordinator -- constructing with { swim } wires
      // swim.onJoin/swim.onDead to coordinator.join()/coordinator.leave()
      // (SwarmCoordinator's own constructor does this).
      // -----------------------------------------------------------------
      const coordinator = new SwarmCoordinator(localPodId, { heartbeatMs, electionTimeoutMs, swim })

      // Compose (not overwrite) the callbacks SwarmCoordinator's own
      // constructor already assigned -- see module doc comment's
      // "SINGLE-SLOT CALLBACK COMPOSITION" section.
      const coordinatorOnJoin = swim.onJoin
      const coordinatorOnDead = swim.onDead // === (podId) => coordinator.leave(podId)

      // `coordinator.leave(podId)` must run exactly once per genuine
      // departure, from WHICHEVER path first observes it -- but SWIM can
      // reach a 'left' state on THIS node's own view two different ways:
      // (a) local direct-detection (#onSuspectTimeout sets 'dead', fires
      // onDead -- wrapped below); or (b) gossip delivering an
      // ALREADY-'left' update from another peer's piggybacked
      // removeMember() update, which skips 'dead' entirely on THIS node's
      // view and fires ONLY onLeave, never onDead (see SwimMembership's own
      // #fireStateCallbacks: a newState of 'left' calls onLeave, not
      // onDead). Without also driving coordinator.leave() from onLeave, a
      // node that only ever learns of a departure via gossip (b) would
      // leave that podId in its own election candidate pool and
      // distributor member list FOREVER, since SwarmCoordinator's own
      // constructor only wires onDead, not onLeave, for removal.
      //
      // Calling coordinator.leave() from onLeave, however, reintroduces the
      // exact recursion hazard "SINGLE-SLOT CALLBACK COMPOSITION" warns
      // about one level deeper: coordinator.leave() itself calls
      // swim.removeMember(), which UNCONDITIONALLY re-fires onLeave (no
      // "already left" guard of its own) -- so onLeave -> coordinator.leave()
      // -> removeMember() -> onLeave again would recurse forever without a
      // guard here. `leaveHandled` is that guard: the first call for a
      // given podId (from either onDead or onLeave) performs the real
      // coordinator.leave() and marks it done; every re-entrant call
      // (including handleLeave()'s own explicit courtesy-leave path,
      // below) becomes a no-op past that point. Cleared on rejoin so a
      // podId that leaves and later rejoins can be processed again.
      const leaveHandled = new Set()
      function ensureCoordinatorLeave(podId) {
        if (leaveHandled.has(podId)) return
        leaveHandled.add(podId)
        coordinatorOnDead(podId)
      }

      swim.onJoin = (podId) => {
        leaveHandled.delete(podId)
        coordinatorOnJoin(podId)
        ctx.emit('swarm:member-joined', { podId })
      }
      swim.onDead = (podId) => {
        ensureCoordinatorLeave(podId)
        ctx.emit('swarm:member-dead', { podId })
      }
      // SwarmCoordinator does not touch onSuspect -- safe to assign directly.
      swim.onSuspect = (podId) => ctx.emit('swarm:member-suspect', { podId })
      swim.onLeave = (podId) => {
        ensureCoordinatorLeave(podId)
        ctx.emit('swarm:member-left', { podId })
      }

      const unsubscribeSwim = ctx.onIncomingData(swimEnvelopeType, (fromPubKey, envelope) => {
        swim.handleMessage(fromPubKey, envelope?.msg)
      })

      swim.start()

      // -----------------------------------------------------------------
      // Leader election heartbeat pump -- see module doc comment's
      // "LEADER ELECTION HEARTBEAT PUMP" section.
      // -----------------------------------------------------------------
      function heartbeatTick() {
        const now = Date.now()
        coordinator.election.receiveHeartbeat(localPodId, now)
        for (const podId of coordinator.listMembers()) {
          if (podId === localPodId) continue
          ctx.sendTo(podId, heartbeatEnvelopeType, {
            from: localPodId,
            timestamp: now,
            meshType: SWARM_HEARTBEAT,
          }).catch((err) => {
            log('mesh-swarm:heartbeat-send-failed', { podId, error: err?.message || String(err) })
          })
        }
        // Always recompute (not gated behind checkLeaderAlive()) -- see
        // module doc comment's "LEADER ELECTION HEARTBEAT PUMP" section for
        // why this is required for convergence, not just silence-detection.
        const previousLeader = coordinator.election.leader
        let newLeader = null
        try {
          newLeader = coordinator.election.elect()
        } catch (err) {
          log('mesh-swarm:election-failed', { error: err?.message || String(err) })
        }
        if (newLeader && newLeader !== previousLeader) {
          ctx.emit('swarm:leader-elected', { leader: newLeader, previousLeader })
        }
      }
      heartbeatTick()
      let heartbeatTimer = setInterval(heartbeatTick, heartbeatMs)

      const unsubscribeHeartbeat = ctx.onIncomingData(heartbeatEnvelopeType, (fromPubKey, msg) => {
        coordinator.election.receiveHeartbeat(fromPubKey, msg?.timestamp)
      })

      // -----------------------------------------------------------------
      // Membership admission control (SWARM_JOIN/SWARM_LEAVE) -- see
      // module doc comment's "SWARM_JOIN / SWARM_LEAVE" section.
      // -----------------------------------------------------------------
      let joinReqSeq = 0
      const nextJoinRequestId = () => `${localPodId}:${Date.now()}:${++joinReqSeq}`
      /** @type {Map<string, {resolve: Function, reject: Function, timer: ReturnType<typeof setTimeout>}>} */
      const pendingJoinRequests = new Map()

      async function handleJoinRequest(fromPubKey, msg) {
        const access = ctx.registry.checkAccess(fromPubKey, accessResource, 'join')
        if (!access.allowed) {
          // Fixed generic reason on both the emitted event and the wire
          // response -- mirrors mesh-compute.mjs's own
          // 'compute:chunk-request-denied' convention, deliberately not
          // leaking the underlying ACL's internal reason (e.g.
          // 'not_in_roster'/'entry_expired') to an unauthorized peer.
          ctx.emit('swarm:join-request-denied', { from: fromPubKey, reason: 'access_denied' })
          await ctx.sendTo(fromPubKey, membershipEnvelopeType, {
            kind: 'join-response', requestId: msg.requestId, ok: false, reason: 'access_denied',
          }).catch((err) => log('mesh-swarm:join-response-send-failed', { to: fromPubKey, error: err?.message || String(err) }))
          return
        }
        swim.addMember(fromPubKey) // cascades: swim.onJoin -> coordinator.join() + ctx.emit('swarm:member-joined')
        ctx.emit('swarm:join-request-granted', { from: fromPubKey })
        await ctx.sendTo(fromPubKey, membershipEnvelopeType, {
          kind: 'join-response', requestId: msg.requestId, ok: true, meshType: SWARM_JOIN,
        }).catch((err) => log('mesh-swarm:join-response-send-failed', { to: fromPubKey, error: err?.message || String(err) }))
      }

      function handleJoinResponse(msg) {
        const pending = pendingJoinRequests.get(msg.requestId)
        if (!pending) return
        pendingJoinRequests.delete(msg.requestId)
        clearTimeout(pending.timer)
        pending.resolve({ ok: !!msg.ok, reason: msg.reason })
      }

      function handleLeave(fromPubKey) {
        // fromPubKey is the network-authenticated sender -- no spoofing
        // surface, so no checkAccess() gate is needed (see module doc
        // comment). Routed through the same ensureCoordinatorLeave() guard
        // as swim.onDead/onLeave (not a direct coordinator.leave() call) so
        // a peer that's ALSO independently detected via SWIM doesn't get a
        // duplicate coordinator.leave() call or a duplicate
        // swarm:member-left event.
        ensureCoordinatorLeave(fromPubKey)
      }

      const unsubscribeMembership = ctx.onIncomingData(membershipEnvelopeType, (fromPubKey, msg) => {
        if (!msg || typeof msg.kind !== 'string') return
        if (msg.kind === 'join-request') {
          handleJoinRequest(fromPubKey, msg).catch((err) => {
            log('mesh-swarm:join-request-handling-failed', { from: fromPubKey, error: err?.message || String(err) })
          })
        } else if (msg.kind === 'join-response') {
          handleJoinResponse(msg)
        } else if (msg.kind === 'leave') {
          handleLeave(fromPubKey)
        }
      })

      async function requestJoin(targetPodId, timeoutMs = requestTimeoutMs) {
        const requestId = nextJoinRequestId()
        const promise = new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingJoinRequests.delete(requestId)
            reject(new Error(`mesh-swarm: join request to ${targetPodId} timed out after ${timeoutMs}ms`))
          }, timeoutMs)
          pendingJoinRequests.set(requestId, { resolve, reject, timer })
        })
        try {
          await ctx.sendTo(targetPodId, membershipEnvelopeType, { kind: 'join-request', requestId, meshType: SWARM_JOIN })
        } catch (err) {
          const pending = pendingJoinRequests.get(requestId)
          if (pending) {
            clearTimeout(pending.timer)
            pendingJoinRequests.delete(requestId)
          }
          throw err
        }
        return promise
      }

      function announceLeave() {
        for (const podId of coordinator.listMembers()) {
          if (podId === localPodId) continue
          ctx.sendTo(podId, membershipEnvelopeType, { kind: 'leave', meshType: SWARM_LEAVE }).catch((err) => {
            log('mesh-swarm:leave-announce-send-failed', { podId, error: err?.message || String(err) })
          })
        }
      }

      // -----------------------------------------------------------------
      // Task submission / assignment notification (SWARM_TASK_ASSIGN) --
      // see module doc comment's "SWARM_TASK_ASSIGN" section.
      // -----------------------------------------------------------------
      /** @type {Map<string, object>} taskId -> task JSON, for tasks assigned to THIS node by a remote submitter. */
      const assignedTasks = new Map()

      function notifyAssignees(task) {
        for (const podId of task.assignedTo) {
          if (podId === localPodId) continue
          ctx.sendTo(podId, taskEnvelopeType, {
            kind: 'assign', meshType: SWARM_TASK_ASSIGN, task: task.toJSON(),
          }).catch((err) => {
            log('mesh-swarm:task-assign-send-failed', { podId, taskId: task.taskId, error: err?.message || String(err) })
          })
          ctx.emit('swarm:task-assigned', { podId, taskId: task.taskId, task: task.toJSON() })
        }
      }

      function submitTaskLocal(description, strategy, input, swarmId) {
        const task = coordinator.submitTask(description, strategy, input, swarmId)
        notifyAssignees(task)
        return task
      }

      let taskReqSeq = 0
      const nextTaskRequestId = () => `${localPodId}:${Date.now()}:${++taskReqSeq}`
      /** @type {Map<string, {resolve: Function, reject: Function, timer: ReturnType<typeof setTimeout>}>} */
      const pendingSubmitRequests = new Map()

      async function handleSubmitRequest(fromPubKey, msg) {
        const access = ctx.registry.checkAccess(fromPubKey, accessResource, 'submit-task')
        if (!access.allowed) {
          // Fixed generic reason/error -- see handleJoinRequest()'s own
          // comment for why the underlying ACL reason is not put on the wire.
          ctx.emit('swarm:submit-task-denied', { from: fromPubKey, reason: 'access_denied' })
          await ctx.sendTo(fromPubKey, taskEnvelopeType, {
            kind: 'submit-response', requestId: msg.requestId, error: 'access denied',
          }).catch((err) => log('mesh-swarm:submit-response-send-failed', { to: fromPubKey, error: err?.message || String(err) }))
          return
        }
        let response
        try {
          const task = submitTaskLocal(msg.description, msg.strategy, msg.input, msg.swarmId)
          response = { kind: 'submit-response', requestId: msg.requestId, task: task.toJSON() }
        } catch (err) {
          response = { kind: 'submit-response', requestId: msg.requestId, error: err?.message || String(err) }
        }
        await ctx.sendTo(fromPubKey, taskEnvelopeType, response).catch((err) => {
          log('mesh-swarm:submit-response-send-failed', { to: fromPubKey, error: err?.message || String(err) })
        })
      }

      function handleSubmitResponse(msg) {
        const pending = pendingSubmitRequests.get(msg.requestId)
        if (!pending) return
        pendingSubmitRequests.delete(msg.requestId)
        clearTimeout(pending.timer)
        if (msg.error) {
          pending.reject(new Error(msg.error))
        } else {
          pending.resolve(msg.task)
        }
      }

      function handleTaskAssign(fromPubKey, msg) {
        assignedTasks.set(msg.task.taskId, { ...msg.task, assignedBy: fromPubKey })
        ctx.emit('swarm:task-received', { from: fromPubKey, task: msg.task })
      }

      const unsubscribeTask = ctx.onIncomingData(taskEnvelopeType, (fromPubKey, msg) => {
        if (!msg || typeof msg.kind !== 'string') return
        if (msg.kind === 'assign') {
          handleTaskAssign(fromPubKey, msg)
        } else if (msg.kind === 'submit-request') {
          handleSubmitRequest(fromPubKey, msg).catch((err) => {
            log('mesh-swarm:submit-request-handling-failed', { from: fromPubKey, error: err?.message || String(err) })
          })
        } else if (msg.kind === 'submit-response') {
          handleSubmitResponse(msg)
        }
      })

      async function requestSubmitTask(targetPodId, { description, strategy, input, swarmId, timeoutMs = requestTimeoutMs } = {}) {
        const requestId = nextTaskRequestId()
        const promise = new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingSubmitRequests.delete(requestId)
            reject(new Error(`mesh-swarm: submit-task request to ${targetPodId} timed out after ${timeoutMs}ms`))
          }, timeoutMs)
          pendingSubmitRequests.set(requestId, { resolve, reject, timer })
        })
        try {
          await ctx.sendTo(targetPodId, taskEnvelopeType, { kind: 'submit-request', requestId, description, strategy, input, swarmId })
        } catch (err) {
          const pending = pendingSubmitRequests.get(requestId)
          if (pending) {
            clearTimeout(pending.timer)
            pendingSubmitRequests.delete(requestId)
          }
          throw err
        }
        return promise
      }

      // -----------------------------------------------------------------
      // api
      // -----------------------------------------------------------------
      const api = {
        // Local SwarmCoordinator surface (never wire-gated -- this node's
        // own operator/application code).
        createSwarm: (swarmId) => coordinator.createSwarm(swarmId),
        disbandSwarm: (swarmId) => coordinator.disbandSwarm(swarmId),
        hasSwarm: (swarmId) => coordinator.hasSwarm(swarmId),
        listSwarms: () => coordinator.listSwarms(),
        listMembers: (swarmId) => coordinator.listMembers(swarmId),
        join: (podId, capabilities, swarmId) => coordinator.join(podId, capabilities, swarmId),
        leave: (podId, swarmId) => coordinator.leave(podId, swarmId),
        submitTask: (description, strategy, input, swarmId) => submitTaskLocal(description, strategy, input, swarmId),
        getTask: (taskId) => coordinator.getTask(taskId),
        completeTask: (taskId, output) => coordinator.completeTask(taskId, output),
        failTask: (taskId, error) => coordinator.failTask(taskId, error),
        cancelTask: (taskId) => coordinator.cancelTask(taskId),
        listTasks: (listOpts) => coordinator.listTasks(listOpts),
        isLeader: () => coordinator.isLeader,
        getLeader: () => coordinator.election.leader,
        checkLeaderAlive: (now) => coordinator.election.checkLeaderAlive(now),
        getMemberState: (podId) => swim.getState(podId),
        getCoordinator: () => coordinator,
        getSwim: () => swim,

        // Wire-level peer interactions (this node as requester).
        requestJoin,
        announceLeave,
        requestSubmitTask,

        // Tasks assigned to THIS node by a remote submitter.
        listAssignedTasks: () => [...assignedTasks.values()],
        getAssignedTask: (taskId) => assignedTasks.get(taskId) ?? null,
      }

      return {
        api,
        teardown() {
          swim.stop()
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer)
            heartbeatTimer = null
          }
          swim.onJoin = null
          swim.onSuspect = null
          swim.onDead = null
          swim.onLeave = null
          unsubscribeSwim()
          unsubscribeHeartbeat()
          unsubscribeMembership()
          unsubscribeTask()
          for (const pending of pendingJoinRequests.values()) {
            clearTimeout(pending.timer)
            pending.reject(new Error('mesh-swarm: service torn down while a join request was still in flight'))
          }
          pendingJoinRequests.clear()
          for (const pending of pendingSubmitRequests.values()) {
            clearTimeout(pending.timer)
            pending.reject(new Error('mesh-swarm: service torn down while a submit-task request was still in flight'))
          }
          pendingSubmitRequests.clear()
        },
      }
    },
  }
}

export {
  DEFAULT_SWIM_ENVELOPE_TYPE,
  DEFAULT_HEARTBEAT_ENVELOPE_TYPE,
  DEFAULT_MEMBERSHIP_ENVELOPE_TYPE,
  DEFAULT_TASK_ENVELOPE_TYPE,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_ELECTION_TIMEOUT_MS,
  DEFAULT_ACCESS_RESOURCE,
  DEFAULT_REQUEST_TIMEOUT_MS,
}
