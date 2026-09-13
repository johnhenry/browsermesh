/**
 * mesh-timestamp.mjs -- Phase 1 of the browsermesh-app-layer-migration plan
 * (issue #120): wraps `peer-timestamp.mjs`'s `TimestampAuthority`/
 * `TimestampProof` as a `MeshService` (`mesh-service.mjs`, Phase C's
 * `attach()`/`ctx` convention).
 *
 * `TimestampAuthority`'s own doc comment already confirms this is a
 * near-trivial wire-up, not a redesign: its constructor only requires
 * `sessions.listSessions()` to EXIST (a duck-type guard) -- nothing inside
 * the class ever actually CALLS it. `PeerNode` (`peer-node.mjs`) already
 * implements `listSessions()` natively, so this file passes the real
 * `peerNode` straight through as `TimestampAuthority`'s `sessions` dependency
 * with zero adapter code, exactly as the plan's Phase 1 section predicted.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE ACTUALLY ADDS: `TimestampAuthority.stamp(eventHash,
 * peerTimestamps)` takes an already-collected `Map<podId, timestamp>` as an
 * explicitly-optional, test-oriented parameter (see that method's own doc
 * comment: "Optional peer timestamps for testing") -- collecting REAL
 * timestamps from REAL connected mesh peers is deliberately left outside
 * `peer-timestamp.mjs` entirely. That collection is the one genuine piece of
 * new logic this wrapper contributes: a small request/response wire protocol
 * (`'time-request'`/`'time-response'`, sharing one envelope `type`, mirroring
 * `mesh-rpc.mjs`'s `kind`-tagged-single-type shape) that asks every currently
 * connected peer (`peerNode.listPeers({status:'connected'})`, the same
 * `peer.fingerprint`-is-the-pubKey convention `mesh-keepalive.mjs` already
 * establishes) for their local clock, waits up to `witnessTimeoutMs` for
 * replies, and hands whatever arrived (a possibly-partial map -- a slow or
 * unresponsive peer just doesn't make it into `peerTimestamps`, exactly the
 * same "graceful partial witness set" shape `TimestampAuthority.stamp()`
 * itself already tolerates) to `authority.stamp()`.
 *
 * ---------------------------------------------------------------------------
 * IDENTITY ADAPTER -- `TimestampAuthority` wants `identity.sign(data) ->
 * Promise<Uint8Array>` plus `identity.podId`. The real signer,
 * `IdentityWallet.sign(podId, data)` (`@johnhenry/browsermesh-core`), takes
 * `podId` as an explicit first argument -- a different shape, the same gap
 * `grant-log.mjs` documents for its own `wallet` dependency. Unless the
 * caller supplies its own `opts.identity`, this file closes that gap the
 * same way `grant-log.mjs`'s `attach()` derives its signer from the real
 * node (`peerNode.podId`/`peerNode.wallet`) rather than asking the factory
 * caller to pre-bind one:
 *
 *   { podId: peerNode.podId, sign: (data) => peerNode.wallet.sign(peerNode.podId, new TextEncoder().encode(data)) }
 *
 * `identity.verify()` is deliberately left UNSET by this default adapter.
 * `TimestampAuthority.verify()` already documents exactly what's missing to
 * provide one for real: verifying a FOREIGN peer's witness signature needs a
 * way to resolve `signerPodId -> raw public key bytes`, and `TimestampProof`
 * carries no embedded pubkey material to do that with (unlike
 * `grant-log.mjs`'s wire records, which embed the raw pubkey precisely so a
 * receiver can verify without a directory lookup). Building that directory
 * is a real, separate piece of design -- out of scope for "thin wrapper, not
 * a redesign" -- so `verify()` here inherits `TimestampAuthority`'s own
 * documented, honest degradation: full signature verification for proofs
 * this authority issued itself (`checked: 'self'`), structural-only
 * otherwise. A caller who builds that directory can supply its own
 * `opts.identity` with a working `verify()` to upgrade this transparently.
 *
 * ---------------------------------------------------------------------------
 * Observability events (`ctx.emit()`, see `mesh-service.mjs`'s module doc
 * comment for the full convention):
 *
 *   - `timestamp:stamped` `{eventHash, canonicalTimestamp, confidence,
 *     witnessCount}` -- `api.stamp()` produced a proof.
 *   - `timestamp:verified` `{eventHash, valid, checked}` -- `api.verify()`
 *     finished checking a proof.
 *   - `timestamp:witness-timeout` `{requestId, expected, received}` --
 *     `witnessTimeoutMs` elapsed with fewer witness replies than peers asked.
 *
 * No browser-only imports at module level.
 */

import { TimestampAuthority } from './peer-timestamp.mjs'

/** Shared envelope `type` for both witness-collection directions (request/response, tagged by `kind`). */
const DEFAULT_ENVELOPE_TYPE = 'mesh-timestamp'

/** How long `stamp()` waits for witness replies before proceeding with whatever arrived. */
const DEFAULT_WITNESS_TIMEOUT_MS = 3000

/**
 * Build a `MeshService` descriptor (`mesh-service.mjs`, Phase C) wrapping
 * `TimestampAuthority`/`TimestampProof`. See this file's module doc comment
 * for the full design writeup.
 *
 * @param {object} [opts]
 * @param {{sign: (data: string) => Promise<Uint8Array>, podId: string, verify?: Function}} [opts.identity]
 *   Defaults to a thin adapter over the attached `peerNode`'s own
 *   `podId`/`wallet` (see module doc comment's "IDENTITY ADAPTER"). Supply
 *   your own to use a different signer, or to add a real `verify()` once a
 *   podId->pubkey directory exists.
 * @param {number} [opts.clockSkewMs] - Passed straight through to
 *   `TimestampAuthority` (default 30000, see `TIMESTAMP_DEFAULTS`).
 * @param {number} [opts.witnessTimeoutMs=3000] - How long `api.stamp()`
 *   waits for witness replies before proceeding with a partial (possibly
 *   empty) set.
 * @param {string} [opts.envelopeType='mesh-timestamp']
 * @param {Function} [opts.onLog]
 * @returns {import('./mesh-service.mjs').MeshService}
 */
export function createTimestampService({
  identity,
  clockSkewMs,
  witnessTimeoutMs = DEFAULT_WITNESS_TIMEOUT_MS,
  envelopeType = DEFAULT_ENVELOPE_TYPE,
  onLog,
} = {}) {
  const log = onLog || (() => {})

  return {
    name: 'timestamp',

    attach(peerNode, ctx) {
      if (typeof peerNode?.listSessions !== 'function') {
        throw new Error(
          'mesh-timestamp: peerNode must be a real PeerNode providing listSessions() ' +
          '(a duck-typed {sendTo, onIncomingData} node, as other MeshServices in this ' +
          'family accept, is not enough here -- see module doc comment).',
        )
      }

      const effectiveIdentity = identity || {
        podId: peerNode.podId,
        // TimestampAuthority signs plain strings (e.g. `${eventHash}:${ts}`);
        // IdentityWallet.sign(podId, data) requires a BufferSource -- same
        // string-to-bytes encoding grant-log.mjs's own wallet.sign() call
        // sites already need (see that file's `new TextEncoder().encode(...)`).
        sign: (data) => peerNode.wallet.sign(peerNode.podId, new TextEncoder().encode(data)),
      }

      // TimestampAuthority's constructor only checks that sessions.listSessions
      // exists -- it never actually calls it (see module doc comment) -- so
      // passing the real peerNode through directly is sufficient, no adapter
      // needed.
      const authority = new TimestampAuthority({
        sessions: peerNode,
        identity: effectiveIdentity,
        clockSkewMs,
        onLog: (level, msg) => log('mesh-timestamp:internal', { level, msg }),
      })

      let reqSeq = 0
      const nextRequestId = () => `${peerNode.podId}:${Date.now()}:${++reqSeq}`

      /**
       * @type {Map<string, {resolve: (responses: Map<string, number>) => void,
       *   timer: ReturnType<typeof setTimeout>, responses: Map<string, number>, expectedCount: number}>}
       */
      const pendingWitnessRequests = new Map()

      const unsubscribe = ctx.onIncomingData(envelopeType, (fromPubKey, msg) => {
        if (!msg || typeof msg.kind !== 'string') return
        if (msg.kind === 'time-request') {
          ctx.sendTo(fromPubKey, envelopeType, { kind: 'time-response', requestId: msg.requestId, timestamp: Date.now() }).catch((err) => {
            log('mesh-timestamp:response-send-failed', { to: fromPubKey, error: err?.message || String(err) })
          })
        } else if (msg.kind === 'time-response') {
          const pending = pendingWitnessRequests.get(msg.requestId)
          if (!pending) return // already resolved (timed out or fully collected) -- ignore
          pending.responses.set(fromPubKey, msg.timestamp)
          if (pending.responses.size >= pending.expectedCount) {
            clearTimeout(pending.timer)
            pendingWitnessRequests.delete(msg.requestId)
            pending.resolve(pending.responses)
          }
        }
      })

      /**
       * Collect real peer timestamps to use as `TimestampAuthority.stamp()`'s
       * `peerTimestamps` argument. See module doc comment.
       * @param {string[]} [targetPubKeys] - Explicit witness set. Defaults to
       *   every currently connected peer.
       * @returns {Promise<Map<string, number>>}
       */
      async function collectWitnesses(targetPubKeys) {
        const targets = targetPubKeys && targetPubKeys.length
          ? targetPubKeys
          : (typeof peerNode.listPeers === 'function'
            ? peerNode.listPeers({ status: 'connected' }).map((p) => p.fingerprint).filter(Boolean)
            : [])

        if (targets.length === 0) return new Map()

        const requestId = nextRequestId()
        const responses = new Map()

        const promise = new Promise((resolve) => {
          const timer = setTimeout(() => {
            pendingWitnessRequests.delete(requestId)
            if (responses.size < targets.length) {
              ctx.emit('timestamp:witness-timeout', { requestId, expected: targets.length, received: responses.size })
            }
            resolve(responses)
          }, witnessTimeoutMs)
          pendingWitnessRequests.set(requestId, { resolve, timer, responses, expectedCount: targets.length })
        })

        await Promise.all(targets.map((pubKey) =>
          ctx.sendTo(pubKey, envelopeType, { kind: 'time-request', requestId }).catch((err) => {
            log('mesh-timestamp:request-send-failed', { to: pubKey, error: err?.message || String(err) })
          }),
        ))

        return promise
      }

      const api = {
        /**
         * Collect real witness timestamps from connected peers (or
         * `opts.peers`, if given), then produce a signed `TimestampProof`.
         * @param {string} eventHash
         * @param {object} [opts]
         * @param {string[]} [opts.peers] - Explicit witness pubKeys. Defaults
         *   to every currently connected peer.
         * @returns {Promise<import('./peer-timestamp.mjs').TimestampProof>}
         */
        async stamp(eventHash, { peers } = {}) {
          const peerTimestamps = await collectWitnesses(peers)
          const proof = await authority.stamp(eventHash, peerTimestamps)
          ctx.emit('timestamp:stamped', {
            eventHash,
            canonicalTimestamp: proof.canonicalTimestamp,
            confidence: proof.confidence,
            witnessCount: proof.witnesses.length,
          })
          return proof
        },

        /**
         * @param {import('./peer-timestamp.mjs').TimestampProof} proof
         * @returns {Promise<{valid: boolean, checked?: string, reason?: string}>}
         */
        async verify(proof) {
          const result = await authority.verify(proof)
          ctx.emit('timestamp:verified', { eventHash: proof?.eventHash, valid: result.valid, checked: result.checked })
          return result
        },

        /** @param {Map<string,number>} [peerTimestamps] @returns {number} */
        getNetworkTime(peerTimestamps) {
          return authority.getNetworkTime(peerTimestamps)
        },

        /** @param {number[]} values @returns {number} */
        computeMedian: TimestampAuthority.computeMedian,
      }

      return {
        api,
        teardown() {
          unsubscribe()
          for (const pending of pendingWitnessRequests.values()) {
            clearTimeout(pending.timer)
            pending.resolve(pending.responses)
          }
          pendingWitnessRequests.clear()
        },
      }
    },
  }
}

export { DEFAULT_ENVELOPE_TYPE, DEFAULT_WITNESS_TIMEOUT_MS }
