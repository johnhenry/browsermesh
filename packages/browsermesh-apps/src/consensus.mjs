/**
 * clawser-mesh-consensus.js -- Voting and consensus protocols for BrowserMesh.
 *
 * Supports simple majority, super majority (>66.7%), unanimous, and weighted
 * voting.  Each Proposal tracks options, quorum, deadline, and status.
 * Ballots record individual votes.  Tally aggregates votes and determines
 * winners based on the proposal's VoteType.
 *
 * ConsensusManager orchestrates the full lifecycle: propose -> vote -> close.
 *
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-mesh-consensus.test.mjs
 */

import { MESH_TYPE } from '@johnhenry/browsermesh-primitives';
import { silentCatch } from './silent-catch.mjs'

// ---------------------------------------------------------------------------
// Wire constants (re-exported from canonical registry)
// ---------------------------------------------------------------------------

export const CONSENSUS_PROPOSE = MESH_TYPE.CONSENSUS_PROPOSE;  // 0xa8
export const CONSENSUS_VOTE = MESH_TYPE.CONSENSUS_VOTE;        // 0xa9
export const CONSENSUS_CLOSE = MESH_TYPE.CONSENSUS_CLOSE;      // 0xeb
export const CONSENSUS_RESULT = MESH_TYPE.CONSENSUS_RESULT;    // 0xec

// ---------------------------------------------------------------------------
// VoteType enum
// ---------------------------------------------------------------------------

/**
 * Valid vote type identifiers.
 *
 * - `simple`    : passes with > 50% of votes
 * - `super`     : passes with > 66.7% of votes
 * - `unanimous` : passes only with 100% agreement
 * - `weighted`  : passes with > 50% of weighted votes
 *
 * @type {Readonly<{ SIMPLE: 'simple', SUPER: 'super', UNANIMOUS: 'unanimous', WEIGHTED: 'weighted' }>}
 */
export const VoteType = Object.freeze({
  SIMPLE: 'simple',
  SUPER: 'super',
  UNANIMOUS: 'unanimous',
  WEIGHTED: 'weighted',
});

/** @type {ReadonlySet<string>} */
const VALID_VOTE_TYPES = new Set(Object.values(VoteType));

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

let _idCounter = 0;

/**
 * Generate a unique proposal ID.
 * @returns {string}
 */
function generateProposalId() {
  return `prop_${Date.now().toString(36)}_${(++_idCounter).toString(36)}`;
}

// ---------------------------------------------------------------------------
// Proposal
// ---------------------------------------------------------------------------

/**
 * A proposal that peers can vote on.
 */
export class Proposal {
  /**
   * @param {object} opts
   * @param {string}   opts.proposalId   - Unique identifier
   * @param {string}   opts.authorPodId  - Pod ID of the author
   * @param {string}   opts.title        - Short title
   * @param {string}   [opts.description] - Optional longer description
   * @param {string[]} opts.options       - Choices voters can pick
   * @param {string}   opts.voteType      - One of VoteType values
   * @param {Map<string,number>|object} [opts.weights] - Pod -> weight map (for weighted voting)
   * @param {number}   opts.quorum        - Minimum votes required
   * @param {number|null} [opts.deadline] - Unix timestamp (ms) after which the proposal expires
   * @param {number}   [opts.createdAt]   - Unix timestamp (ms)
   * @param {string}   [opts.status]      - 'open' | 'closed' | 'expired'
   */
  constructor({
    proposalId,
    authorPodId,
    title,
    description = null,
    options,
    voteType,
    weights = null,
    quorum,
    deadline = null,
    createdAt = Date.now(),
    status = 'open',
  }) {
    if (!proposalId || typeof proposalId !== 'string') {
      throw new Error('proposalId is required and must be a non-empty string');
    }
    if (!authorPodId || typeof authorPodId !== 'string') {
      throw new Error('authorPodId is required and must be a non-empty string');
    }
    if (!title || typeof title !== 'string') {
      throw new Error('title is required and must be a non-empty string');
    }
    if (!Array.isArray(options) || options.length < 2) {
      throw new Error('options must be an array with at least 2 choices');
    }
    if (!VALID_VOTE_TYPES.has(voteType)) {
      throw new Error(`voteType must be one of: ${[...VALID_VOTE_TYPES].join(', ')}`);
    }
    if (typeof quorum !== 'number' || quorum < 1) {
      throw new Error('quorum must be a positive number');
    }

    this.proposalId = proposalId;
    this.authorPodId = authorPodId;
    this.title = title;
    this.description = description;
    this.options = [...options];
    this.voteType = voteType;
    this.weights = weights instanceof Map
      ? new Map(weights)
      : (weights ? new Map(Object.entries(weights)) : null);
    this.quorum = quorum;
    this.deadline = deadline;
    this.createdAt = createdAt;
    this.status = status;
  }

  /**
   * Check if this proposal has expired relative to `now`.
   *
   * @param {number} [now=Date.now()]
   * @returns {boolean}
   */
  isExpired(now = Date.now()) {
    if (this.deadline === null) return false;
    return now >= this.deadline;
  }

  /**
   * Serialize to a JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      proposalId: this.proposalId,
      authorPodId: this.authorPodId,
      title: this.title,
      description: this.description,
      options: [...this.options],
      voteType: this.voteType,
      weights: this.weights ? Object.fromEntries(this.weights) : null,
      quorum: this.quorum,
      deadline: this.deadline,
      createdAt: this.createdAt,
      status: this.status,
    };
  }

  /**
   * Re-hydrate from a plain object.
   * @param {object} data
   * @returns {Proposal}
   */
  static fromJSON(data) {
    return new Proposal({
      ...data,
      weights: data.weights ? new Map(Object.entries(data.weights)) : null,
    });
  }
}

// ---------------------------------------------------------------------------
// Ballot
// ---------------------------------------------------------------------------

/**
 * An individual vote cast by a peer.
 */
export class Ballot {
  /**
   * @param {object} opts
   * @param {string} opts.proposalId - Which proposal this ballot is for
   * @param {string} opts.voterPodId - Pod ID of the voter
   * @param {string} opts.choice     - The chosen option (must be in proposal.options)
   * @param {number} [opts.weight]   - Vote weight (defaults to 1)
   * @param {number} [opts.timestamp]
   * @param {string|null} [opts.signature] - Optional cryptographic signature
   */
  constructor({
    proposalId,
    voterPodId,
    choice,
    weight = 1,
    timestamp = Date.now(),
    signature = null,
  }) {
    if (!proposalId || typeof proposalId !== 'string') {
      throw new Error('proposalId is required');
    }
    if (!voterPodId || typeof voterPodId !== 'string') {
      throw new Error('voterPodId is required');
    }
    if (!choice || typeof choice !== 'string') {
      throw new Error('choice is required');
    }
    if (typeof weight !== 'number' || weight < 0) {
      throw new Error('weight must be a non-negative number');
    }

    this.proposalId = proposalId;
    this.voterPodId = voterPodId;
    this.choice = choice;
    this.weight = weight;
    this.timestamp = timestamp;
    this.signature = signature;
  }

  /**
   * Serialize to a JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      proposalId: this.proposalId,
      voterPodId: this.voterPodId,
      choice: this.choice,
      weight: this.weight,
      timestamp: this.timestamp,
      signature: this.signature,
    };
  }

  /**
   * Re-hydrate from a plain object.
   * @param {object} data
   * @returns {Ballot}
   */
  static fromJSON(data) {
    return new Ballot(data);
  }
}

// ---------------------------------------------------------------------------
// Tally
// ---------------------------------------------------------------------------

/**
 * Aggregates votes for a single Proposal and determines the outcome.
 */
export class Tally {
  /** @type {Proposal} */
  #proposal;

  /** @type {Map<string, Ballot>} voterPodId -> Ballot */
  #ballots = new Map();

  /**
   * @param {Proposal} proposal
   */
  constructor(proposal) {
    if (!(proposal instanceof Proposal)) {
      throw new Error('proposal must be a Proposal instance');
    }
    this.#proposal = proposal;
  }

  /**
   * Cast a ballot. Throws on duplicate voter, invalid choice, or
   * closed/expired proposal.
   *
   * @param {Ballot} ballot
   */
  cast(ballot) {
    if (!(ballot instanceof Ballot)) {
      throw new Error('ballot must be a Ballot instance');
    }
    if (ballot.proposalId !== this.#proposal.proposalId) {
      throw new Error('ballot proposalId does not match proposal');
    }
    if (this.#proposal.status === 'closed') {
      throw new Error('proposal is closed');
    }
    if (this.#proposal.status === 'expired' || this.#proposal.isExpired()) {
      throw new Error('proposal is expired');
    }
    if (!this.#proposal.options.includes(ballot.choice)) {
      throw new Error(`invalid choice "${ballot.choice}"; valid options: ${this.#proposal.options.join(', ')}`);
    }
    if (this.#ballots.has(ballot.voterPodId)) {
      throw new Error(`duplicate vote from "${ballot.voterPodId}"`);
    }

    this.#ballots.set(ballot.voterPodId, ballot);
  }

  /**
   * Get aggregated results per choice.
   *
   * @returns {Map<string, { votes: number, weight: number }>}
   */
  getResults() {
    /** @type {Map<string, { votes: number, weight: number }>} */
    const results = new Map();
    for (const opt of this.#proposal.options) {
      results.set(opt, { votes: 0, weight: 0 });
    }
    for (const ballot of this.#ballots.values()) {
      const entry = results.get(ballot.choice);
      if (entry) {
        entry.votes += 1;
        entry.weight += ballot.weight;
      }
    }
    return results;
  }

  /**
   * Determine the winning choice based on the proposal's VoteType.
   *
   * For `simple`: winner needs > 50% of total votes.
   * For `super`:  winner needs > 66.7% of total votes.
   * For `unanimous`: winner needs 100% of total votes.
   * For `weighted`: winner needs > 50% of total weight.
   *
   * @returns {{ choice: string, votes: number, weight: number, passed: boolean } | null}
   *   null if no votes have been cast.
   */
  getWinner() {
    if (this.#ballots.size === 0) return null;

    const results = this.getResults();
    let best = null;

    for (const [choice, data] of results) {
      if (!best || data.votes > best.votes || (data.votes === best.votes && data.weight > best.weight)) {
        best = { choice, votes: data.votes, weight: data.weight };
      }
    }

    if (!best) return null;

    const total = this.totalVotes;
    const totalW = this.totalWeight;
    let passed = false;

    switch (this.#proposal.voteType) {
      case VoteType.SIMPLE:
        passed = best.votes > total / 2;
        break;
      case VoteType.SUPER:
        passed = best.votes > total * (2 / 3);
        break;
      case VoteType.UNANIMOUS:
        passed = best.votes === total;
        break;
      case VoteType.WEIGHTED:
        passed = totalW > 0 && best.weight > totalW / 2;
        break;
    }

    return { ...best, passed };
  }

  /**
   * Total number of ballots cast.
   * @returns {number}
   */
  get totalVotes() {
    return this.#ballots.size;
  }

  /**
   * Sum of all ballot weights.
   * @returns {number}
   */
  get totalWeight() {
    let sum = 0;
    for (const b of this.#ballots.values()) sum += b.weight;
    return sum;
  }

  /**
   * Whether the quorum has been met.
   * @returns {boolean}
   */
  get hasQuorum() {
    return this.#ballots.size >= this.#proposal.quorum;
  }

  /**
   * List of voter pod IDs.
   * @returns {string[]}
   */
  get voterList() {
    return [...this.#ballots.keys()];
  }

  /**
   * The proposal this tally is tracking.
   * @returns {Proposal}
   */
  get proposal() {
    return this.#proposal;
  }

  /**
   * Serialize to a JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      proposal: this.#proposal.toJSON(),
      ballots: [...this.#ballots.values()].map(b => b.toJSON()),
    };
  }

  /**
   * Re-hydrate from a plain object.
   * @param {object} data
   * @returns {Tally}
   */
  static fromJSON(data) {
    const proposal = Proposal.fromJSON(data.proposal);
    const tally = new Tally(proposal);
    // Temporarily mark open to allow casting stored ballots
    const originalStatus = proposal.status;
    proposal.status = 'open';
    const originalDeadline = proposal.deadline;
    proposal.deadline = null;
    for (const bd of data.ballots) {
      tally.cast(Ballot.fromJSON(bd));
    }
    proposal.status = originalStatus;
    proposal.deadline = originalDeadline;
    return tally;
  }
}

// ---------------------------------------------------------------------------
// ConsensusManager
// ---------------------------------------------------------------------------

/**
 * Orchestrates proposal lifecycle: create, vote, close, expire.
 *
 * Validator sets (`addValidator`/`removeValidator`/`listValidators`) gate
 * WHO may propose/vote — a simple membership check, not a consensus
 * protocol. This class implements majority/super-majority/unanimous/
 * weighted VOTING (see VoteType), not PBFT: there's no pre-prepare/
 * prepare/commit round, no view changes, and no Byzantine fault
 * tolerance guarantee (3f+1 quorum). For that, see the opt-in
 * `@johnhenry/raijin-consensus` package wired at clawser-pod.js's PBFT integration
 * (~line 417-478) — a separate, heavier protocol for when Byzantine
 * safety actually matters (e.g. payment finality). This class is the
 * lightweight default: mesh-wide polls, config changes, elections.
 */
export class ConsensusManager {
  /** @type {Map<string, Tally>} proposalId -> Tally */
  #tallies = new Map();

  /** @type {number} */
  #maxProposals;

  /** @type {function|null} */
  #broadcastFn = null;

  /** @type {Set<string>} podIds allowed to propose/vote; empty = open membership (no gating) */
  #validators = new Set();

  /**
   * @param {object} [opts]
   * @param {number} [opts.maxProposals=1000] - Maximum active proposals
   * @param {string[]} [opts.validators] - Initial validator set (empty/omitted = open membership)
   */
  constructor(opts = {}) {
    this.#maxProposals = opts.maxProposals ?? 1000;
    for (const podId of opts.validators || []) this.#validators.add(podId);
  }

  /**
   * Add a pod to the validator set. Once at least one validator is
   * registered, `propose()`/`vote()` are gated to validator-only — an
   * empty set means open membership (no gating), preserving the
   * pre-validator-set behavior by default.
   *
   * @param {string} podId
   */
  addValidator(podId) {
    if (!podId || typeof podId !== 'string') {
      throw new Error('podId is required and must be a non-empty string');
    }
    this.#validators.add(podId);
  }

  /**
   * Remove a pod from the validator set. Does not retroactively affect
   * ballots already cast.
   *
   * @param {string} podId
   * @returns {boolean} True if the pod was a validator
   */
  removeValidator(podId) {
    return this.#validators.delete(podId);
  }

  /**
   * List all registered validator pod IDs.
   * @returns {string[]}
   */
  listValidators() {
    return [...this.#validators];
  }

  /**
   * Whether `podId` is a registered validator. Always true when the
   * validator set is empty (open membership).
   *
   * @param {string} podId
   * @returns {boolean}
   */
  isValidator(podId) {
    if (this.#validators.size === 0) return true;
    return this.#validators.has(podId);
  }

  /**
   * Create a new proposal and register its tally.
   *
   * @param {string}   authorPodId - Pod ID of the author
   * @param {string}   title       - Proposal title
   * @param {string[]} options     - Choices
   * @param {string}   voteType    - One of VoteType values
   * @param {object}   [opts]
   * @param {string}   [opts.description]
   * @param {Map<string,number>|object} [opts.weights]
   * @param {number}   [opts.quorum=1]
   * @param {number|null} [opts.deadline]
   * @returns {Proposal}
   */
  propose(authorPodId, title, options, voteType, opts = {}) {
    if (this.#tallies.size >= this.#maxProposals) {
      throw new Error(`maximum proposals (${this.#maxProposals}) reached`);
    }
    if (!this.isValidator(authorPodId)) {
      throw new Error(`"${authorPodId}" is not a registered validator`);
    }

    const proposal = new Proposal({
      proposalId: generateProposalId(),
      authorPodId,
      title,
      description: opts.description ?? null,
      options,
      voteType,
      weights: opts.weights ?? null,
      quorum: opts.quorum ?? 1,
      deadline: opts.deadline ?? null,
    });

    this.#tallies.set(proposal.proposalId, new Tally(proposal));
    return proposal;
  }

  /**
   * Get a proposal by ID.
   *
   * @param {string} proposalId
   * @returns {Proposal|null}
   */
  getProposal(proposalId) {
    const tally = this.#tallies.get(proposalId);
    return tally ? tally.proposal : null;
  }

  /**
   * Cast a vote on a proposal.
   *
   * @param {string} proposalId
   * @param {string} voterPodId
   * @param {string} choice
   * @param {number} [weight=1]
   * @returns {Ballot}
   */
  vote(proposalId, voterPodId, choice, weight = 1) {
    const tally = this.#tallies.get(proposalId);
    if (!tally) {
      throw new Error(`proposal "${proposalId}" not found`);
    }
    if (!this.isValidator(voterPodId)) {
      throw new Error(`"${voterPodId}" is not a registered validator`);
    }

    const ballot = new Ballot({
      proposalId,
      voterPodId,
      choice,
      weight,
    });

    tally.cast(ballot);
    return ballot;
  }

  /**
   * Close a proposal and return the results.
   *
   * @param {string} proposalId
   * @returns {{ winner: object|null, results: Map<string, { votes: number, weight: number }> }}
   */
  closeProposal(proposalId) {
    const tally = this.#tallies.get(proposalId);
    if (!tally) {
      throw new Error(`proposal "${proposalId}" not found`);
    }
    if (tally.proposal.status === 'closed') {
      throw new Error('proposal is already closed');
    }

    tally.proposal.status = 'closed';

    return {
      winner: tally.getWinner(),
      results: tally.getResults(),
    };
  }

  /**
   * Get the tally for a proposal.
   *
   * @param {string} proposalId
   * @returns {Tally|null}
   */
  getTally(proposalId) {
    return this.#tallies.get(proposalId) || null;
  }

  /**
   * List proposals, optionally filtered by status.
   *
   * @param {object} [opts]
   * @param {string} [opts.status] - Filter by 'open', 'closed', or 'expired'
   * @returns {Proposal[]}
   */
  listProposals(opts = {}) {
    const proposals = [...this.#tallies.values()].map(t => t.proposal);
    if (opts.status) {
      return proposals.filter(p => p.status === opts.status);
    }
    return proposals;
  }

  /**
   * Expire all proposals whose deadline has passed.
   *
   * @param {number} [now=Date.now()]
   * @returns {number} Number of proposals expired
   */
  expireAll(now = Date.now()) {
    let count = 0;
    for (const tally of this.#tallies.values()) {
      const p = tally.proposal;
      if (p.status === 'open' && p.isExpired(now)) {
        p.status = 'expired';
        count++;
      }
    }
    return count;
  }

  /**
   * Total number of tracked proposals.
   * @returns {number}
   */
  get size() {
    return this.#tallies.size;
  }

  /**
   * Wire the ConsensusManager to a mesh transport layer.
   *
   * Outbound: proposals, votes, close, and result messages are sent via
   * `broadcastFn(type, payload)`.
   *
   * Inbound: messages are received via `subscribeFn(type, handler)` where
   * handler receives `(payload, fromPodId)`.
   *
   * @param {function} broadcastFn - `(wireType: number, payload: object) => void`
   * @param {function} subscribeFn - `(wireType: number, handler: (payload, fromPodId) => void) => void`
   */
  wireTransport(broadcastFn, subscribeFn) {
    if (typeof broadcastFn !== 'function' || typeof subscribeFn !== 'function') {
      throw new Error('broadcastFn and subscribeFn must be functions');
    }

    this.#broadcastFn = broadcastFn;

    // Inbound: receive proposals
    subscribeFn(CONSENSUS_PROPOSE, (payload, fromPodId) => {
      try {
        if (!this.isValidator(payload.authorPodId)) {
          throw new Error(`"${payload.authorPodId}" is not a registered validator`);
        }
        const proposal = Proposal.fromJSON(payload);
        const tally = new Tally(proposal);
        this.#tallies.set(proposal.proposalId, tally);
      } catch (e) { silentCatch('clawser-mesh-consensus', 'ignore-malformed-proposals', e) }
    });

    // Inbound: receive votes
    subscribeFn(CONSENSUS_VOTE, (payload, fromPodId) => {
      try {
        const { proposalId, choice, weight } = payload;
        this.vote(proposalId, fromPodId, choice, weight ?? 1);
      } catch (e) { silentCatch('clawser-mesh-consensus', 'ignore-invalid-votes', e) }
    });

    // Inbound: receive close requests
    subscribeFn(CONSENSUS_CLOSE, (payload, fromPodId) => {
      try { this.closeProposal(payload.proposalId); } catch (e) { silentCatch('clawser-mesh-consensus', 'this.closeProposal', e) }
    });

    // Inbound: receive results (informational, for sync)
    subscribeFn(CONSENSUS_RESULT, (payload, fromPodId) => {
      // Results are informational — remote peers can use them to update UI
      // No action needed on the ConsensusManager side
    });
  }

  /**
   * Broadcast a proposal over the transport.
   *
   * @param {Proposal} proposal
   */
  broadcastProposal(proposal) {
    if (this.#broadcastFn) {
      this.#broadcastFn(CONSENSUS_PROPOSE, proposal.toJSON());
    }
  }

  /**
   * Broadcast a vote over the transport.
   *
   * @param {string} proposalId
   * @param {string} voterPodId
   * @param {string} choice
   * @param {number} [weight=1]
   */
  broadcastVote(proposalId, voterPodId, choice, weight = 1) {
    if (this.#broadcastFn) {
      this.#broadcastFn(CONSENSUS_VOTE, { proposalId, voterPodId, choice, weight });
    }
  }

  /**
   * Broadcast a close request over the transport.
   *
   * @param {string} proposalId
   */
  broadcastClose(proposalId) {
    if (this.#broadcastFn) {
      this.#broadcastFn(CONSENSUS_CLOSE, { proposalId });
    }
  }

  /**
   * Broadcast a result over the transport.
   *
   * @param {string} proposalId
   * @param {object} result
   */
  broadcastResult(proposalId, result) {
    if (this.#broadcastFn) {
      this.#broadcastFn(CONSENSUS_RESULT, { proposalId, ...result });
    }
  }
}
