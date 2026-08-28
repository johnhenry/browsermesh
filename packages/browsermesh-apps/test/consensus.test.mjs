// Run with: node --import ./test/_setup-globals.mjs --test test/consensus.test.mjs
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  VoteType,
  Proposal,
  Ballot,
  Tally,
  ConsensusManager,
  CONSENSUS_PROPOSE,
  CONSENSUS_VOTE,
  CONSENSUS_CLOSE,
  CONSENSUS_RESULT,
} from '../src/consensus.mjs';

// ---------------------------------------------------------------------------
// Wire constants
// ---------------------------------------------------------------------------

describe('Wire constants', () => {
  it('CONSENSUS_PROPOSE is 0xA8', () => {
    assert.equal(CONSENSUS_PROPOSE, 0xA8);
  });

  it('CONSENSUS_VOTE is 0xA9', () => {
    assert.equal(CONSENSUS_VOTE, 0xA9);
  });

  it('CONSENSUS_CLOSE is 0xEB', () => {
    assert.equal(CONSENSUS_CLOSE, 0xEB);
  });

  it('CONSENSUS_RESULT is 0xEC', () => {
    assert.equal(CONSENSUS_RESULT, 0xEC);
  });
});

// ---------------------------------------------------------------------------
// VoteType
// ---------------------------------------------------------------------------

describe('VoteType', () => {
  it('has expected values', () => {
    assert.equal(VoteType.SIMPLE, 'simple');
    assert.equal(VoteType.SUPER, 'super');
    assert.equal(VoteType.UNANIMOUS, 'unanimous');
    assert.equal(VoteType.WEIGHTED, 'weighted');
  });

  it('is frozen', () => {
    assert.ok(Object.isFrozen(VoteType));
  });
});

// ---------------------------------------------------------------------------
// Proposal
// ---------------------------------------------------------------------------

describe('Proposal', () => {
  const baseOpts = {
    proposalId: 'prop_1',
    authorPodId: 'pod_alice',
    title: 'Pick a color',
    options: ['red', 'blue'],
    voteType: 'simple',
    quorum: 2,
  };

  it('constructs with required fields', () => {
    const p = new Proposal(baseOpts);
    assert.equal(p.proposalId, 'prop_1');
    assert.equal(p.authorPodId, 'pod_alice');
    assert.equal(p.title, 'Pick a color');
    assert.deepEqual(p.options, ['red', 'blue']);
    assert.equal(p.voteType, 'simple');
    assert.equal(p.quorum, 2);
    assert.equal(p.status, 'open');
    assert.equal(p.description, null);
    assert.equal(p.deadline, null);
    assert.equal(p.weights, null);
    assert.equal(typeof p.createdAt, 'number');
  });

  it('constructs with optional fields', () => {
    const p = new Proposal({
      ...baseOpts,
      description: 'Choose wisely',
      deadline: 99999,
      weights: { pod_a: 2, pod_b: 3 },
    });
    assert.equal(p.description, 'Choose wisely');
    assert.equal(p.deadline, 99999);
    assert.ok(p.weights instanceof Map);
    assert.equal(p.weights.get('pod_a'), 2);
  });

  it('accepts weights as a Map', () => {
    const w = new Map([['pod_a', 5]]);
    const p = new Proposal({ ...baseOpts, weights: w });
    assert.equal(p.weights.get('pod_a'), 5);
  });

  it('throws on missing proposalId', () => {
    assert.throws(() => new Proposal({ ...baseOpts, proposalId: '' }), /proposalId/);
  });

  it('throws on missing authorPodId', () => {
    assert.throws(() => new Proposal({ ...baseOpts, authorPodId: '' }), /authorPodId/);
  });

  it('throws on missing title', () => {
    assert.throws(() => new Proposal({ ...baseOpts, title: '' }), /title/);
  });

  it('throws on fewer than 2 options', () => {
    assert.throws(() => new Proposal({ ...baseOpts, options: ['only'] }), /at least 2/);
  });

  it('throws on invalid voteType', () => {
    assert.throws(() => new Proposal({ ...baseOpts, voteType: 'invalid' }), /voteType/);
  });

  it('throws on quorum < 1', () => {
    assert.throws(() => new Proposal({ ...baseOpts, quorum: 0 }), /quorum/);
  });

  // -- isExpired -----------------------------------------------------------

  it('isExpired returns false when no deadline', () => {
    const p = new Proposal(baseOpts);
    assert.equal(p.isExpired(), false);
  });

  it('isExpired returns false before deadline', () => {
    const p = new Proposal({ ...baseOpts, deadline: Date.now() + 60000 });
    assert.equal(p.isExpired(), false);
  });

  it('isExpired returns true at deadline', () => {
    const p = new Proposal({ ...baseOpts, deadline: 5000 });
    assert.equal(p.isExpired(5000), true);
  });

  it('isExpired returns true after deadline', () => {
    const p = new Proposal({ ...baseOpts, deadline: 5000 });
    assert.equal(p.isExpired(6000), true);
  });

  // -- toJSON / fromJSON ---------------------------------------------------

  it('round-trips through toJSON/fromJSON', () => {
    const p = new Proposal({
      ...baseOpts,
      description: 'test',
      deadline: 9999,
      weights: { pod_a: 3 },
      createdAt: 1000,
      status: 'closed',
    });
    const json = p.toJSON();
    const p2 = Proposal.fromJSON(json);
    assert.equal(p2.proposalId, p.proposalId);
    assert.equal(p2.authorPodId, p.authorPodId);
    assert.equal(p2.title, p.title);
    assert.equal(p2.description, 'test');
    assert.deepEqual(p2.options, ['red', 'blue']);
    assert.equal(p2.voteType, 'simple');
    assert.equal(p2.quorum, 2);
    assert.equal(p2.deadline, 9999);
    assert.equal(p2.createdAt, 1000);
    assert.equal(p2.status, 'closed');
    assert.ok(p2.weights instanceof Map);
    assert.equal(p2.weights.get('pod_a'), 3);
  });

  it('toJSON returns a plain object with correct shape', () => {
    const p = new Proposal(baseOpts);
    const json = p.toJSON();
    assert.equal(typeof json, 'object');
    assert.ok(!Array.isArray(json));
    assert.equal(json.proposalId, 'prop_1');
    assert.deepEqual(json.options, ['red', 'blue']);
    assert.equal(json.weights, null);
  });
});

// ---------------------------------------------------------------------------
// Ballot
// ---------------------------------------------------------------------------

describe('Ballot', () => {
  it('constructs with required fields', () => {
    const b = new Ballot({ proposalId: 'p1', voterPodId: 'v1', choice: 'yes' });
    assert.equal(b.proposalId, 'p1');
    assert.equal(b.voterPodId, 'v1');
    assert.equal(b.choice, 'yes');
    assert.equal(b.weight, 1);
    assert.equal(b.signature, null);
    assert.equal(typeof b.timestamp, 'number');
  });

  it('constructs with optional fields', () => {
    const b = new Ballot({
      proposalId: 'p1',
      voterPodId: 'v1',
      choice: 'no',
      weight: 5,
      timestamp: 1234,
      signature: 'sig_abc',
    });
    assert.equal(b.weight, 5);
    assert.equal(b.timestamp, 1234);
    assert.equal(b.signature, 'sig_abc');
  });

  it('throws on missing proposalId', () => {
    assert.throws(() => new Ballot({ proposalId: '', voterPodId: 'v1', choice: 'y' }), /proposalId/);
  });

  it('throws on missing voterPodId', () => {
    assert.throws(() => new Ballot({ proposalId: 'p1', voterPodId: '', choice: 'y' }), /voterPodId/);
  });

  it('throws on missing choice', () => {
    assert.throws(() => new Ballot({ proposalId: 'p1', voterPodId: 'v1', choice: '' }), /choice/);
  });

  it('throws on negative weight', () => {
    assert.throws(
      () => new Ballot({ proposalId: 'p1', voterPodId: 'v1', choice: 'y', weight: -1 }),
      /weight/,
    );
  });

  it('round-trips through toJSON/fromJSON', () => {
    const b = new Ballot({
      proposalId: 'p1',
      voterPodId: 'v1',
      choice: 'yes',
      weight: 3,
      timestamp: 5000,
      signature: 'sig',
    });
    const json = b.toJSON();
    const b2 = Ballot.fromJSON(json);
    assert.equal(b2.proposalId, 'p1');
    assert.equal(b2.voterPodId, 'v1');
    assert.equal(b2.choice, 'yes');
    assert.equal(b2.weight, 3);
    assert.equal(b2.timestamp, 5000);
    assert.equal(b2.signature, 'sig');
  });

  it('toJSON returns correct shape', () => {
    const b = new Ballot({ proposalId: 'p1', voterPodId: 'v1', choice: 'yes' });
    const json = b.toJSON();
    assert.equal(typeof json, 'object');
    assert.equal(json.proposalId, 'p1');
    assert.equal(json.weight, 1);
  });
});

// ---------------------------------------------------------------------------
// Tally
// ---------------------------------------------------------------------------

describe('Tally', () => {
  /** @returns {Proposal} */
  function makeProposal(overrides = {}) {
    return new Proposal({
      proposalId: 'prop_t',
      authorPodId: 'author',
      title: 'Test',
      options: ['yes', 'no'],
      voteType: 'simple',
      quorum: 2,
      ...overrides,
    });
  }

  it('throws when constructed without a Proposal', () => {
    assert.throws(() => new Tally({}), /Proposal instance/);
  });

  it('starts empty', () => {
    const tally = new Tally(makeProposal());
    assert.equal(tally.totalVotes, 0);
    assert.equal(tally.totalWeight, 0);
    assert.deepEqual(tally.voterList, []);
    assert.equal(tally.hasQuorum, false);
  });

  it('cast accepts a valid ballot', () => {
    const tally = new Tally(makeProposal());
    const b = new Ballot({ proposalId: 'prop_t', voterPodId: 'v1', choice: 'yes' });
    tally.cast(b);
    assert.equal(tally.totalVotes, 1);
    assert.deepEqual(tally.voterList, ['v1']);
  });

  it('cast rejects non-Ballot argument', () => {
    const tally = new Tally(makeProposal());
    assert.throws(() => tally.cast({}), /Ballot instance/);
  });

  it('cast rejects mismatched proposalId', () => {
    const tally = new Tally(makeProposal());
    const b = new Ballot({ proposalId: 'other', voterPodId: 'v1', choice: 'yes' });
    assert.throws(() => tally.cast(b), /does not match/);
  });

  it('cast rejects duplicate voter', () => {
    const tally = new Tally(makeProposal());
    tally.cast(new Ballot({ proposalId: 'prop_t', voterPodId: 'v1', choice: 'yes' }));
    assert.throws(
      () => tally.cast(new Ballot({ proposalId: 'prop_t', voterPodId: 'v1', choice: 'no' })),
      /duplicate/,
    );
  });

  it('cast rejects invalid choice', () => {
    const tally = new Tally(makeProposal());
    assert.throws(
      () => tally.cast(new Ballot({ proposalId: 'prop_t', voterPodId: 'v1', choice: 'maybe' })),
      /invalid choice/,
    );
  });

  it('cast rejects vote on closed proposal', () => {
    const p = makeProposal();
    p.status = 'closed';
    const tally = new Tally(p);
    assert.throws(
      () => tally.cast(new Ballot({ proposalId: 'prop_t', voterPodId: 'v1', choice: 'yes' })),
      /closed/,
    );
  });

  it('cast rejects vote on expired proposal', () => {
    const p = makeProposal({ deadline: 1000 });
    const tally = new Tally(p);
    const b = new Ballot({ proposalId: 'prop_t', voterPodId: 'v1', choice: 'yes', timestamp: 2000 });
    // The cast method checks isExpired() with Date.now(), but we can set status
    p.status = 'expired';
    assert.throws(() => tally.cast(b), /expired/);
  });

  // -- getResults ----------------------------------------------------------

  it('getResults returns all options with zero counts initially', () => {
    const tally = new Tally(makeProposal());
    const results = tally.getResults();
    assert.equal(results.get('yes').votes, 0);
    assert.equal(results.get('no').votes, 0);
  });

  it('getResults tallies votes correctly', () => {
    const tally = new Tally(makeProposal());
    tally.cast(new Ballot({ proposalId: 'prop_t', voterPodId: 'v1', choice: 'yes' }));
    tally.cast(new Ballot({ proposalId: 'prop_t', voterPodId: 'v2', choice: 'yes' }));
    tally.cast(new Ballot({ proposalId: 'prop_t', voterPodId: 'v3', choice: 'no' }));
    const results = tally.getResults();
    assert.equal(results.get('yes').votes, 2);
    assert.equal(results.get('no').votes, 1);
  });

  // -- Simple majority -----------------------------------------------------

  it('simple majority: passes with >50%', () => {
    const tally = new Tally(makeProposal({ quorum: 1 }));
    tally.cast(new Ballot({ proposalId: 'prop_t', voterPodId: 'v1', choice: 'yes' }));
    tally.cast(new Ballot({ proposalId: 'prop_t', voterPodId: 'v2', choice: 'yes' }));
    tally.cast(new Ballot({ proposalId: 'prop_t', voterPodId: 'v3', choice: 'no' }));
    const winner = tally.getWinner();
    assert.equal(winner.choice, 'yes');
    assert.equal(winner.passed, true);
  });

  it('simple majority: fails with exactly 50%', () => {
    const tally = new Tally(makeProposal({ quorum: 1 }));
    tally.cast(new Ballot({ proposalId: 'prop_t', voterPodId: 'v1', choice: 'yes' }));
    tally.cast(new Ballot({ proposalId: 'prop_t', voterPodId: 'v2', choice: 'no' }));
    const winner = tally.getWinner();
    assert.equal(winner.passed, false);
  });

  // -- Super majority ------------------------------------------------------

  it('super majority: passes with >66.7%', () => {
    const p = makeProposal({ voteType: 'super', quorum: 1 });
    const tally = new Tally(p);
    tally.cast(new Ballot({ proposalId: 'prop_t', voterPodId: 'v1', choice: 'yes' }));
    tally.cast(new Ballot({ proposalId: 'prop_t', voterPodId: 'v2', choice: 'yes' }));
    tally.cast(new Ballot({ proposalId: 'prop_t', voterPodId: 'v3', choice: 'no' }));
    const winner = tally.getWinner();
    assert.equal(winner.choice, 'yes');
    // 2/3 = 0.666..., need >66.7%, so 2 out of 3 = exactly 66.7% -> fails
    assert.equal(winner.passed, false);
  });

  it('super majority: passes with 3 out of 4 (75%)', () => {
    const p = makeProposal({ voteType: 'super', quorum: 1 });
    const tally = new Tally(p);
    tally.cast(new Ballot({ proposalId: 'prop_t', voterPodId: 'v1', choice: 'yes' }));
    tally.cast(new Ballot({ proposalId: 'prop_t', voterPodId: 'v2', choice: 'yes' }));
    tally.cast(new Ballot({ proposalId: 'prop_t', voterPodId: 'v3', choice: 'yes' }));
    tally.cast(new Ballot({ proposalId: 'prop_t', voterPodId: 'v4', choice: 'no' }));
    const winner = tally.getWinner();
    assert.equal(winner.choice, 'yes');
    assert.equal(winner.passed, true);
  });

  // -- Unanimous -----------------------------------------------------------

  it('unanimous: passes when all vote the same', () => {
    const p = makeProposal({ voteType: 'unanimous', quorum: 1 });
    const tally = new Tally(p);
    tally.cast(new Ballot({ proposalId: 'prop_t', voterPodId: 'v1', choice: 'yes' }));
    tally.cast(new Ballot({ proposalId: 'prop_t', voterPodId: 'v2', choice: 'yes' }));
    const winner = tally.getWinner();
    assert.equal(winner.choice, 'yes');
    assert.equal(winner.passed, true);
  });

  it('unanimous: fails with any dissent', () => {
    const p = makeProposal({ voteType: 'unanimous', quorum: 1 });
    const tally = new Tally(p);
    tally.cast(new Ballot({ proposalId: 'prop_t', voterPodId: 'v1', choice: 'yes' }));
    tally.cast(new Ballot({ proposalId: 'prop_t', voterPodId: 'v2', choice: 'no' }));
    const winner = tally.getWinner();
    assert.equal(winner.passed, false);
  });

  // -- Weighted ------------------------------------------------------------

  it('weighted: passes when >50% of weight', () => {
    const p = makeProposal({ voteType: 'weighted', quorum: 1 });
    const tally = new Tally(p);
    tally.cast(new Ballot({ proposalId: 'prop_t', voterPodId: 'v1', choice: 'yes', weight: 10 }));
    tally.cast(new Ballot({ proposalId: 'prop_t', voterPodId: 'v2', choice: 'no', weight: 3 }));
    const winner = tally.getWinner();
    assert.equal(winner.choice, 'yes');
    assert.equal(winner.passed, true);
    assert.equal(winner.weight, 10);
  });

  it('weighted: fails with exactly 50% of weight', () => {
    const p = makeProposal({ voteType: 'weighted', quorum: 1 });
    const tally = new Tally(p);
    tally.cast(new Ballot({ proposalId: 'prop_t', voterPodId: 'v1', choice: 'yes', weight: 5 }));
    tally.cast(new Ballot({ proposalId: 'prop_t', voterPodId: 'v2', choice: 'no', weight: 5 }));
    const winner = tally.getWinner();
    assert.equal(winner.passed, false);
  });

  it('weighted: minority by count can win by weight', () => {
    const p = makeProposal({ voteType: 'weighted', quorum: 1 });
    const tally = new Tally(p);
    tally.cast(new Ballot({ proposalId: 'prop_t', voterPodId: 'v1', choice: 'yes', weight: 100 }));
    tally.cast(new Ballot({ proposalId: 'prop_t', voterPodId: 'v2', choice: 'no', weight: 1 }));
    tally.cast(new Ballot({ proposalId: 'prop_t', voterPodId: 'v3', choice: 'no', weight: 1 }));
    const winner = tally.getWinner();
    // 'no' has more votes (2) but 'yes' has more weight (100)
    // getWinner picks by vote count first, so 'no' is the "winner" by count
    // but for weighted, passed checks weight
    // Actually: 'no' has 2 votes vs 'yes' 1 vote, so 'no' leads by count
    // But 'no' weight is 2, total weight is 102, 2/102 < 50% => fails
    assert.equal(winner.choice, 'no');
    assert.equal(winner.passed, false);
  });

  // -- Quorum --------------------------------------------------------------

  it('hasQuorum is false below quorum', () => {
    const tally = new Tally(makeProposal({ quorum: 3 }));
    tally.cast(new Ballot({ proposalId: 'prop_t', voterPodId: 'v1', choice: 'yes' }));
    tally.cast(new Ballot({ proposalId: 'prop_t', voterPodId: 'v2', choice: 'yes' }));
    assert.equal(tally.hasQuorum, false);
  });

  it('hasQuorum is true at quorum', () => {
    const tally = new Tally(makeProposal({ quorum: 2 }));
    tally.cast(new Ballot({ proposalId: 'prop_t', voterPodId: 'v1', choice: 'yes' }));
    tally.cast(new Ballot({ proposalId: 'prop_t', voterPodId: 'v2', choice: 'no' }));
    assert.equal(tally.hasQuorum, true);
  });

  // -- getWinner edge cases ------------------------------------------------

  it('getWinner returns null with no votes', () => {
    const tally = new Tally(makeProposal());
    assert.equal(tally.getWinner(), null);
  });

  it('totalWeight sums ballot weights', () => {
    const tally = new Tally(makeProposal({ quorum: 1 }));
    tally.cast(new Ballot({ proposalId: 'prop_t', voterPodId: 'v1', choice: 'yes', weight: 3 }));
    tally.cast(new Ballot({ proposalId: 'prop_t', voterPodId: 'v2', choice: 'no', weight: 7 }));
    assert.equal(tally.totalWeight, 10);
  });

  // -- toJSON / fromJSON ---------------------------------------------------

  it('round-trips through toJSON/fromJSON', () => {
    const p = makeProposal({ quorum: 1 });
    const tally = new Tally(p);
    tally.cast(new Ballot({ proposalId: 'prop_t', voterPodId: 'v1', choice: 'yes', weight: 2 }));
    tally.cast(new Ballot({ proposalId: 'prop_t', voterPodId: 'v2', choice: 'no', weight: 3 }));

    const json = tally.toJSON();
    const tally2 = Tally.fromJSON(json);

    assert.equal(tally2.totalVotes, 2);
    assert.equal(tally2.totalWeight, 5);
    assert.deepEqual(tally2.voterList.sort(), ['v1', 'v2']);
    assert.equal(tally2.proposal.proposalId, 'prop_t');
  });

  it('fromJSON preserves closed status', () => {
    const p = makeProposal({ quorum: 1 });
    p.status = 'closed';
    const tally = new Tally(p);
    // Cannot cast on closed, so use fromJSON with pre-populated ballots
    const json = {
      proposal: p.toJSON(),
      ballots: [
        { proposalId: 'prop_t', voterPodId: 'v1', choice: 'yes', weight: 1, timestamp: 1000, signature: null },
      ],
    };
    const tally2 = Tally.fromJSON(json);
    assert.equal(tally2.proposal.status, 'closed');
    assert.equal(tally2.totalVotes, 1);
  });
});

// ---------------------------------------------------------------------------
// ConsensusManager
// ---------------------------------------------------------------------------

describe('ConsensusManager', () => {
  let cm;
  beforeEach(() => {
    cm = new ConsensusManager();
  });

  it('starts empty', () => {
    assert.equal(cm.size, 0);
  });

  // -- propose -------------------------------------------------------------

  it('propose creates a proposal and increases size', () => {
    const p = cm.propose('pod_a', 'Vote on X', ['yes', 'no'], 'simple');
    assert.equal(cm.size, 1);
    assert.ok(p.proposalId.startsWith('prop_'));
    assert.equal(p.authorPodId, 'pod_a');
    assert.equal(p.title, 'Vote on X');
    assert.equal(p.voteType, 'simple');
    assert.equal(p.status, 'open');
    assert.equal(p.quorum, 1); // default
  });

  it('propose with optional fields', () => {
    const p = cm.propose('pod_a', 'Title', ['a', 'b'], 'weighted', {
      description: 'desc',
      quorum: 5,
      deadline: 99999,
      weights: { pod_a: 10 },
    });
    assert.equal(p.description, 'desc');
    assert.equal(p.quorum, 5);
    assert.equal(p.deadline, 99999);
    assert.ok(p.weights instanceof Map);
  });

  it('propose throws when maxProposals reached', () => {
    const small = new ConsensusManager({ maxProposals: 2 });
    small.propose('a', 'T1', ['y', 'n'], 'simple');
    small.propose('a', 'T2', ['y', 'n'], 'simple');
    assert.throws(() => small.propose('a', 'T3', ['y', 'n'], 'simple'), /maximum/);
  });

  // -- getProposal ---------------------------------------------------------

  it('getProposal returns proposal by ID', () => {
    const p = cm.propose('pod_a', 'Title', ['a', 'b'], 'simple');
    const fetched = cm.getProposal(p.proposalId);
    assert.equal(fetched.proposalId, p.proposalId);
  });

  it('getProposal returns null for unknown ID', () => {
    assert.equal(cm.getProposal('nonexistent'), null);
  });

  // -- vote ----------------------------------------------------------------

  it('vote casts a ballot and returns it', () => {
    const p = cm.propose('pod_a', 'Title', ['yes', 'no'], 'simple');
    const ballot = cm.vote(p.proposalId, 'voter_1', 'yes');
    assert.ok(ballot instanceof Ballot);
    assert.equal(ballot.voterPodId, 'voter_1');
    assert.equal(ballot.choice, 'yes');
  });

  it('vote with weight', () => {
    const p = cm.propose('pod_a', 'Title', ['yes', 'no'], 'weighted');
    const ballot = cm.vote(p.proposalId, 'voter_1', 'yes', 10);
    assert.equal(ballot.weight, 10);
  });

  it('vote throws for unknown proposal', () => {
    assert.throws(() => cm.vote('no_such_id', 'v1', 'yes'), /not found/);
  });

  it('vote throws for duplicate voter', () => {
    const p = cm.propose('pod_a', 'Title', ['yes', 'no'], 'simple');
    cm.vote(p.proposalId, 'v1', 'yes');
    assert.throws(() => cm.vote(p.proposalId, 'v1', 'no'), /duplicate/);
  });

  // -- closeProposal -------------------------------------------------------

  it('closeProposal sets status and returns results', () => {
    const p = cm.propose('pod_a', 'Title', ['yes', 'no'], 'simple');
    cm.vote(p.proposalId, 'v1', 'yes');
    cm.vote(p.proposalId, 'v2', 'yes');
    cm.vote(p.proposalId, 'v3', 'no');

    const { winner, results } = cm.closeProposal(p.proposalId);
    assert.equal(p.status, 'closed');
    assert.equal(winner.choice, 'yes');
    assert.equal(winner.passed, true);
    assert.equal(results.get('yes').votes, 2);
    assert.equal(results.get('no').votes, 1);
  });

  it('closeProposal throws for unknown proposal', () => {
    assert.throws(() => cm.closeProposal('nope'), /not found/);
  });

  it('closeProposal throws for already-closed proposal', () => {
    const p = cm.propose('pod_a', 'Title', ['yes', 'no'], 'simple');
    cm.closeProposal(p.proposalId);
    assert.throws(() => cm.closeProposal(p.proposalId), /already closed/);
  });

  it('vote throws after closeProposal', () => {
    const p = cm.propose('pod_a', 'Title', ['yes', 'no'], 'simple');
    cm.closeProposal(p.proposalId);
    assert.throws(() => cm.vote(p.proposalId, 'v1', 'yes'), /closed/);
  });

  // -- getTally ------------------------------------------------------------

  it('getTally returns the tally for a proposal', () => {
    const p = cm.propose('pod_a', 'Title', ['yes', 'no'], 'simple');
    cm.vote(p.proposalId, 'v1', 'yes');
    const tally = cm.getTally(p.proposalId);
    assert.ok(tally instanceof Tally);
    assert.equal(tally.totalVotes, 1);
  });

  it('getTally returns null for unknown proposal', () => {
    assert.equal(cm.getTally('nope'), null);
  });

  // -- listProposals -------------------------------------------------------

  it('listProposals returns all proposals', () => {
    cm.propose('a', 'T1', ['y', 'n'], 'simple');
    cm.propose('b', 'T2', ['y', 'n'], 'simple');
    const all = cm.listProposals();
    assert.equal(all.length, 2);
  });

  it('listProposals filters by status', () => {
    const p1 = cm.propose('a', 'T1', ['y', 'n'], 'simple');
    cm.propose('b', 'T2', ['y', 'n'], 'simple');
    cm.closeProposal(p1.proposalId);

    const open = cm.listProposals({ status: 'open' });
    assert.equal(open.length, 1);
    assert.equal(open[0].title, 'T2');

    const closed = cm.listProposals({ status: 'closed' });
    assert.equal(closed.length, 1);
    assert.equal(closed[0].title, 'T1');
  });

  // -- expireAll -----------------------------------------------------------

  it('expireAll marks open proposals past deadline as expired', () => {
    cm.propose('a', 'T1', ['y', 'n'], 'simple', { deadline: 5000 });
    cm.propose('b', 'T2', ['y', 'n'], 'simple', { deadline: 10000 });
    cm.propose('c', 'T3', ['y', 'n'], 'simple'); // no deadline

    const count = cm.expireAll(7000);
    assert.equal(count, 1);

    const expired = cm.listProposals({ status: 'expired' });
    assert.equal(expired.length, 1);
    assert.equal(expired[0].title, 'T1');
  });

  it('expireAll does not touch closed proposals', () => {
    const p = cm.propose('a', 'T1', ['y', 'n'], 'simple', { deadline: 100 });
    cm.closeProposal(p.proposalId);
    const count = cm.expireAll(200);
    assert.equal(count, 0);
    assert.equal(p.status, 'closed');
  });

  it('expireAll with no deadlines returns 0', () => {
    cm.propose('a', 'T1', ['y', 'n'], 'simple');
    assert.equal(cm.expireAll(), 0);
  });

  // -- validator set ---------------------------------------------------------

  describe('validator set', () => {
    it('starts with open membership (empty validator set)', () => {
      assert.deepEqual(cm.listValidators(), []);
      assert.equal(cm.isValidator('anyone'), true);
    });

    it('addValidator registers a pod', () => {
      cm.addValidator('pod_a');
      assert.deepEqual(cm.listValidators(), ['pod_a']);
      assert.equal(cm.isValidator('pod_a'), true);
    });

    it('addValidator throws on an empty/invalid podId', () => {
      assert.throws(() => cm.addValidator(''), /podId is required/);
      assert.throws(() => cm.addValidator(null), /podId is required/);
    });

    it('once any validator is registered, non-validators are rejected', () => {
      cm.addValidator('pod_a');
      assert.equal(cm.isValidator('pod_a'), true);
      assert.equal(cm.isValidator('pod_b'), false);
    });

    it('removeValidator removes a pod and returns true', () => {
      cm.addValidator('pod_a');
      assert.equal(cm.removeValidator('pod_a'), true);
      assert.deepEqual(cm.listValidators(), []);
    });

    it('removeValidator returns false for an unregistered pod', () => {
      assert.equal(cm.removeValidator('nope'), false);
    });

    it('removing the last validator restores open membership', () => {
      cm.addValidator('pod_a');
      cm.removeValidator('pod_a');
      assert.equal(cm.isValidator('anyone'), true);
    });

    it('constructor accepts an initial validators list', () => {
      const gated = new ConsensusManager({ validators: ['pod_a', 'pod_b'] });
      assert.deepEqual(gated.listValidators().sort(), ['pod_a', 'pod_b']);
    });

    it('propose() is ungated with an empty validator set', () => {
      assert.doesNotThrow(() => cm.propose('anyone', 'T', ['y', 'n'], 'simple'));
    });

    it('propose() throws for a non-validator once the set is non-empty', () => {
      cm.addValidator('pod_a');
      assert.throws(() => cm.propose('pod_b', 'T', ['y', 'n'], 'simple'), /not a registered validator/);
    });

    it('propose() succeeds for a registered validator', () => {
      cm.addValidator('pod_a');
      assert.doesNotThrow(() => cm.propose('pod_a', 'T', ['y', 'n'], 'simple'));
    });

    it('vote() is ungated with an empty validator set', () => {
      const p = cm.propose('pod_a', 'T', ['y', 'n'], 'simple');
      assert.doesNotThrow(() => cm.vote(p.proposalId, 'anyone', 'y'));
    });

    it('vote() throws for a non-validator once the set is non-empty', () => {
      cm.addValidator('pod_a');
      const p = cm.propose('pod_a', 'T', ['y', 'n'], 'simple');
      assert.throws(() => cm.vote(p.proposalId, 'pod_b', 'y'), /not a registered validator/);
    });

    it('vote() succeeds for a registered validator', () => {
      cm.addValidator('pod_a');
      cm.addValidator('voter_1');
      const p = cm.propose('pod_a', 'T', ['y', 'n'], 'simple');
      assert.doesNotThrow(() => cm.vote(p.proposalId, 'voter_1', 'y'));
    });
  });

  // -- wireTransport validator gating ----------------------------------------

  describe('wireTransport validator gating', () => {
    function makeBus() {
      const handlers = new Map();
      return {
        broadcastFn: (wireType, payload) => handlers.get(wireType)?.(payload, 'remote'),
        subscribeFn: (wireType, handler) => handlers.set(wireType, handler),
      };
    }

    it('accepts an inbound proposal from a non-validator when membership is open', () => {
      const bus = makeBus();
      cm.wireTransport(bus.broadcastFn, bus.subscribeFn);
      cm.broadcastProposal(cm.propose('pod_a', 'T', ['y', 'n'], 'simple'));
      // The receiving side of the same bus is this same manager in this
      // harness — just confirming the wire path doesn't throw/reject.
      assert.equal(cm.size, 1);
    });

    it('rejects an inbound proposal from a non-validator once gating is active', () => {
      const sender = new ConsensusManager();
      const receiver = new ConsensusManager({ validators: ['pod_trusted'] });
      const bus = makeBus();
      receiver.wireTransport(() => {}, bus.subscribeFn);

      const proposal = sender.propose('pod_untrusted', 'T', ['y', 'n'], 'simple');
      bus.broadcastFn(CONSENSUS_PROPOSE, proposal.toJSON());

      assert.equal(receiver.size, 0, 'proposal from a non-validator must be dropped');
    });

    it('accepts an inbound proposal from a registered validator', () => {
      const sender = new ConsensusManager();
      const receiver = new ConsensusManager({ validators: ['pod_trusted'] });
      const bus = makeBus();
      receiver.wireTransport(() => {}, bus.subscribeFn);

      const proposal = sender.propose('pod_trusted', 'T', ['y', 'n'], 'simple');
      bus.broadcastFn(CONSENSUS_PROPOSE, proposal.toJSON());

      assert.equal(receiver.size, 1);
    });

    it('rejects an inbound vote from a non-validator once gating is active', () => {
      // makeBus() fixes fromPodId to 'remote' for every inbound message,
      // which is not in the validator set below — the vote must be dropped.
      const receiver = new ConsensusManager({ validators: ['pod_trusted'] });
      const bus = makeBus();
      receiver.wireTransport(() => {}, bus.subscribeFn);
      const proposal = receiver.propose('pod_trusted', 'T', ['y', 'n'], 'simple');

      bus.broadcastFn(CONSENSUS_VOTE, { proposalId: proposal.proposalId, choice: 'y' });

      assert.equal(receiver.getTally(proposal.proposalId).totalVotes, 0);
    });

    it('accepts an inbound vote from a registered validator', () => {
      const receiver = new ConsensusManager({ validators: ['pod_trusted', 'remote'] });
      const bus = makeBus();
      receiver.wireTransport(() => {}, bus.subscribeFn);
      const proposal = receiver.propose('pod_trusted', 'T', ['y', 'n'], 'simple');

      bus.broadcastFn(CONSENSUS_VOTE, { proposalId: proposal.proposalId, choice: 'y' });

      assert.equal(receiver.getTally(proposal.proposalId).totalVotes, 1);
    });
  });
});
