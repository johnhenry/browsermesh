// Run with: node --import ./test/_setup-globals.mjs --test test/peer-payments.test.mjs
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  PAYMENT_DEFAULTS,
  CreditLedger,
  WebLNProvider,
} from '../src/peer-payments.mjs';

// ── PAYMENT_DEFAULTS ──────────────────────────────────────────────

describe('PAYMENT_DEFAULTS', () => {
  it('contains all expected keys', () => {
    assert.equal(PAYMENT_DEFAULTS.initialCredits, 100);
    assert.equal(PAYMENT_DEFAULTS.creditCostPerToken, 0.001);
    assert.equal(PAYMENT_DEFAULTS.creditCostPerMbStorage, 0.1);
    assert.equal(PAYMENT_DEFAULTS.creditCostPerMinuteCompute, 1);
    assert.equal(PAYMENT_DEFAULTS.creditEarnPerMbServed, 0.05);
    assert.equal(PAYMENT_DEFAULTS.creditEarnPerTokenServed, 0.0005);
  });

  it('is frozen', () => {
    assert.ok(Object.isFrozen(PAYMENT_DEFAULTS));
  });

  it('has exactly 6 entries', () => {
    assert.equal(Object.keys(PAYMENT_DEFAULTS).length, 6);
  });
});

// ── CreditLedger ──────────────────────────────────────────────────

describe('CreditLedger', () => {
  /** @type {CreditLedger} */
  let ledger;

  beforeEach(() => {
    ledger = new CreditLedger();
  });

  // -- initialCredits for new peers --

  it('returns initialCredits for unknown peers', () => {
    assert.equal(ledger.getBalance('pod-new'), 100);
  });

  it('uses custom initialCredits', () => {
    const custom = new CreditLedger({ initialCredits: 500 });
    assert.equal(custom.getBalance('pod-x'), 500);
  });

  // -- charge --

  describe('charge', () => {
    it('reduces balance and returns success', () => {
      const result = ledger.charge('pod-alice', 30, 'token usage');
      assert.equal(result.success, true);
      assert.equal(result.balance, 70);
      assert.ok(result.txId);
      assert.equal(ledger.getBalance('pod-alice'), 70);
    });

    it('fails on insufficient balance', () => {
      const result = ledger.charge('pod-alice', 200, 'too much');
      assert.equal(result.success, false);
      assert.equal(result.txId, null);
      assert.equal(result.balance, 100); // unchanged
      assert.equal(ledger.getBalance('pod-alice'), 100);
    });

    it('throws on non-positive amount', () => {
      assert.throws(() => ledger.charge('pod-alice', 0), RangeError);
      assert.throws(() => ledger.charge('pod-alice', -5), RangeError);
    });

    it('allows charging exact balance', () => {
      const result = ledger.charge('pod-alice', 100);
      assert.equal(result.success, true);
      assert.equal(result.balance, 0);
    });
  });

  // -- credit --

  describe('credit', () => {
    it('adds to balance and returns success', () => {
      const result = ledger.credit('pod-alice', 50, 'serving files');
      assert.equal(result.success, true);
      assert.equal(result.balance, 150);
      assert.ok(result.txId);
      assert.equal(ledger.getBalance('pod-alice'), 150);
    });

    it('throws on non-positive amount', () => {
      assert.throws(() => ledger.credit('pod-alice', 0), RangeError);
      assert.throws(() => ledger.credit('pod-alice', -10), RangeError);
    });

    it('accumulates across multiple credits', () => {
      ledger.credit('pod-alice', 20);
      ledger.credit('pod-alice', 30);
      assert.equal(ledger.getBalance('pod-alice'), 150); // 100 + 20 + 30
    });
  });

  // -- transfer --

  describe('transfer', () => {
    it('debits sender and credits receiver', () => {
      const result = ledger.transfer('pod-alice', 'pod-bob', 40, 'service fee');
      assert.equal(result.success, true);
      assert.ok(result.txId);
      assert.equal(ledger.getBalance('pod-alice'), 60);
      assert.equal(ledger.getBalance('pod-bob'), 140);
    });

    it('fails on insufficient sender balance', () => {
      const result = ledger.transfer('pod-alice', 'pod-bob', 200);
      assert.equal(result.success, false);
      assert.equal(result.txId, null);
      assert.equal(ledger.getBalance('pod-alice'), 100); // unchanged
    });

    it('throws on non-positive amount', () => {
      assert.throws(
        () => ledger.transfer('pod-alice', 'pod-bob', 0),
        RangeError,
      );
      assert.throws(
        () => ledger.transfer('pod-alice', 'pod-bob', -1),
        RangeError,
      );
    });
  });

  // -- getTransactions --

  describe('getTransactions', () => {
    beforeEach(() => {
      ledger.charge('pod-alice', 10, 'tx-1');
      ledger.credit('pod-alice', 5, 'tx-2');
      ledger.transfer('pod-alice', 'pod-bob', 20, 'tx-3');
    });

    it('returns all transactions when no filter', () => {
      const txs = ledger.getTransactions();
      assert.equal(txs.length, 3);
    });

    it('filters by podId', () => {
      const txs = ledger.getTransactions('pod-bob');
      // pod-bob is involved in the transfer (as toPodId)
      assert.equal(txs.length, 1);
      assert.equal(txs[0].type, 'transfer');
    });

    it('limits results', () => {
      const txs = ledger.getTransactions(undefined, 2);
      assert.equal(txs.length, 2);
    });

    it('returns copies (mutations do not leak)', () => {
      const txs = ledger.getTransactions();
      txs.push({ fake: true });
      assert.equal(ledger.getTransactions().length, 3);
    });
  });

  // -- getTransactionById --

  describe('getTransactionById', () => {
    it('returns transaction by ID', () => {
      const result = ledger.charge('pod-alice', 10);
      const tx = ledger.getTransactionById(result.txId);
      assert.ok(tx);
      assert.equal(tx.txId, result.txId);
      assert.equal(tx.type, 'charge');
    });

    it('returns null for unknown ID', () => {
      assert.equal(ledger.getTransactionById('tx_nonexistent'), null);
    });
  });

  // -- calculateCost --

  describe('calculateCost', () => {
    it('calculates token cost', () => {
      assert.equal(ledger.calculateCost('tokens', 1000), 1);
    });

    it('calculates storage cost', () => {
      assert.equal(ledger.calculateCost('storage_mb', 10), 1);
    });

    it('calculates compute cost', () => {
      assert.equal(ledger.calculateCost('compute_minutes', 5), 5);
    });

    it('throws on unknown resource type', () => {
      assert.throws(
        () => ledger.calculateCost('unknown', 10),
        /Unknown resource type/,
      );
    });

    it('throws on negative quantity', () => {
      assert.throws(
        () => ledger.calculateCost('tokens', -5),
        RangeError,
      );
    });

    it('returns 0 for zero quantity', () => {
      assert.equal(ledger.calculateCost('tokens', 0), 0);
    });
  });

  // -- getSummary --

  describe('getSummary', () => {
    it('returns balance, totals, and transaction count', () => {
      ledger.credit('pod-alice', 50, 'earned');
      ledger.charge('pod-alice', 20, 'spent');
      ledger.transfer('pod-alice', 'pod-bob', 10);

      const summary = ledger.getSummary('pod-alice');
      assert.equal(summary.balance, 120); // 100 + 50 - 20 - 10
      assert.equal(summary.totalEarned, 50);
      assert.equal(summary.totalSpent, 30); // 20 charge + 10 transfer
      assert.equal(summary.transactionCount, 3);
    });

    it('counts transfer receipts as earned for receiver', () => {
      ledger.transfer('pod-alice', 'pod-bob', 30);
      const summary = ledger.getSummary('pod-bob');
      assert.equal(summary.totalEarned, 30);
      assert.equal(summary.transactionCount, 1);
    });

    it('returns defaults for new peer', () => {
      const summary = ledger.getSummary('pod-new');
      assert.equal(summary.balance, 100);
      assert.equal(summary.totalEarned, 0);
      assert.equal(summary.totalSpent, 0);
      assert.equal(summary.transactionCount, 0);
    });
  });

  // -- toJSON / fromJSON round-trip --

  describe('toJSON / fromJSON', () => {
    it('round-trips balances and transactions', () => {
      ledger.credit('pod-alice', 50);
      ledger.charge('pod-alice', 20);
      ledger.transfer('pod-alice', 'pod-bob', 10);

      const json = ledger.toJSON();
      const restored = CreditLedger.fromJSON(json);

      assert.equal(restored.getBalance('pod-alice'), 120);
      assert.equal(restored.getBalance('pod-bob'), 110);
      assert.equal(restored.getTransactions().length, 3);
    });

    it('preserves initialCredits and maxTransactions', () => {
      const custom = new CreditLedger({
        initialCredits: 200,
        maxTransactions: 50,
      });
      custom.credit('pod-x', 10);

      const json = custom.toJSON();
      assert.equal(json.initialCredits, 200);
      assert.equal(json.maxTransactions, 50);

      const restored = CreditLedger.fromJSON(json);
      // New peer should get 200 initial credits
      assert.equal(restored.getBalance('pod-new'), 200);
    });

    it('produces JSON-safe output', () => {
      ledger.credit('pod-alice', 10);
      const json = ledger.toJSON();
      assert.equal(typeof json.initialCredits, 'number');
      assert.equal(typeof json.maxTransactions, 'number');
      assert.ok(json.balances && typeof json.balances === 'object');
      assert.ok(Array.isArray(json.transactions));
    });
  });

  // -- events --

  describe('events', () => {
    it('fires charge event', () => {
      const events = [];
      ledger.on('charge', (tx) => events.push(tx));
      ledger.charge('pod-alice', 10);
      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'charge');
      assert.equal(events[0].amount, 10);
    });

    it('fires credit event', () => {
      const events = [];
      ledger.on('credit', (tx) => events.push(tx));
      ledger.credit('pod-alice', 25);
      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'credit');
    });

    it('fires transfer event', () => {
      const events = [];
      ledger.on('transfer', (tx) => events.push(tx));
      ledger.transfer('pod-alice', 'pod-bob', 15);
      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'transfer');
    });

    it('fires insufficient event on failed charge', () => {
      const events = [];
      ledger.on('insufficient', (info) => events.push(info));
      ledger.charge('pod-alice', 200);
      assert.equal(events.length, 1);
      assert.equal(events[0].podId, 'pod-alice');
      assert.equal(events[0].amount, 200);
    });

    it('off removes a listener', () => {
      const events = [];
      const handler = (tx) => events.push(tx);
      ledger.on('charge', handler);
      ledger.charge('pod-alice', 5);
      assert.equal(events.length, 1);

      ledger.off('charge', handler);
      ledger.charge('pod-alice', 5);
      assert.equal(events.length, 1); // no new event
    });
  });

  // -- maxTransactions cap --

  describe('maxTransactions cap', () => {
    it('drops oldest transactions when cap exceeded', () => {
      const small = new CreditLedger({
        initialCredits: 1000,
        maxTransactions: 5,
      });

      for (let i = 0; i < 8; i++) {
        small.credit('pod-alice', 1, `tx-${i}`);
      }

      const txs = small.getTransactions();
      assert.equal(txs.length, 5);
      // Oldest should be tx-3 (indices 0-2 were dropped)
      assert.equal(txs[0].memo, 'tx-3');
      assert.equal(txs[4].memo, 'tx-7');
    });
  });
});

// ── WebLNProvider ─────────────────────────────────────────────────

describe('WebLNProvider', () => {
  // -- without window.webln --

  describe('without webln', () => {
    it('available returns false', () => {
      const provider = new WebLNProvider();
      assert.equal(provider.available, false);
    });

    it('connected returns false', () => {
      const provider = new WebLNProvider();
      assert.equal(provider.connected, false);
    });

    it('connect returns false when unavailable', async () => {
      const provider = new WebLNProvider();
      const result = await provider.connect();
      assert.equal(result, false);
      assert.equal(provider.connected, false);
    });

    it('getBalance returns null when not connected', async () => {
      const provider = new WebLNProvider();
      const result = await provider.getBalance();
      assert.equal(result, null);
    });

    it('createInvoice returns null when not connected', async () => {
      const provider = new WebLNProvider();
      const result = await provider.createInvoice(1000, 'test');
      assert.equal(result, null);
    });

    it('payInvoice returns null when not connected', async () => {
      const provider = new WebLNProvider();
      const result = await provider.payInvoice('lnbc1...');
      assert.equal(result, null);
    });

    it('getInfo returns null when not connected', async () => {
      const provider = new WebLNProvider();
      const result = await provider.getInfo();
      assert.equal(result, null);
    });

    it('toJSON reflects unavailable state', () => {
      const provider = new WebLNProvider();
      const json = provider.toJSON();
      assert.equal(json.available, false);
      assert.equal(json.connected, false);
      assert.equal(json.type, 'webln');
    });
  });

  // -- with mock window.webln --

  describe('with mock webln', () => {
    /** @type {object} */
    let mockWebln;

    beforeEach(() => {
      mockWebln = {
        enable: async () => {},
        getBalance: async () => ({ balance: 50000 }),
        makeInvoice: async ({ amount, defaultMemo }) => ({
          paymentRequest: `lnbc${amount}mock`,
          rHash: 'abc123',
        }),
        sendPayment: async (pr) => ({
          preimage: 'preimage_xyz',
        }),
        getInfo: async () => ({
          node: { alias: 'TestNode', pubkey: 'pk_123' },
        }),
      };
    });

    it('available returns true with injected webln', () => {
      const provider = new WebLNProvider({ webln: mockWebln });
      assert.equal(provider.available, true);
    });

    it('connect succeeds', async () => {
      const provider = new WebLNProvider({ webln: mockWebln });
      const result = await provider.connect();
      assert.equal(result, true);
      assert.equal(provider.connected, true);
    });

    it('connect handles enable failure', async () => {
      mockWebln.enable = async () => { throw new Error('User rejected') };
      const provider = new WebLNProvider({ webln: mockWebln });
      const result = await provider.connect();
      assert.equal(result, false);
      assert.equal(provider.connected, false);
    });

    it('getBalance returns sats after connect', async () => {
      const provider = new WebLNProvider({ webln: mockWebln });
      await provider.connect();
      const balance = await provider.getBalance();
      assert.equal(balance, 50000);
    });

    it('getBalance handles numeric return', async () => {
      mockWebln.getBalance = async () => 12345;
      const provider = new WebLNProvider({ webln: mockWebln });
      await provider.connect();
      const balance = await provider.getBalance();
      assert.equal(balance, 12345);
    });

    it('getBalance returns null on error', async () => {
      mockWebln.getBalance = async () => { throw new Error('fail') };
      const provider = new WebLNProvider({ webln: mockWebln });
      await provider.connect();
      const balance = await provider.getBalance();
      assert.equal(balance, null);
    });

    it('createInvoice returns paymentRequest and rHash', async () => {
      const provider = new WebLNProvider({ webln: mockWebln });
      await provider.connect();
      const invoice = await provider.createInvoice(1000, 'test payment');
      assert.equal(invoice.paymentRequest, 'lnbc1000mock');
      assert.equal(invoice.rHash, 'abc123');
    });

    it('createInvoice returns null on error', async () => {
      mockWebln.makeInvoice = async () => { throw new Error('fail') };
      const provider = new WebLNProvider({ webln: mockWebln });
      await provider.connect();
      const invoice = await provider.createInvoice(1000);
      assert.equal(invoice, null);
    });

    it('payInvoice returns preimage on success', async () => {
      const provider = new WebLNProvider({ webln: mockWebln });
      await provider.connect();
      const result = await provider.payInvoice('lnbc1000mock');
      assert.equal(result.preimage, 'preimage_xyz');
      assert.equal(result.success, true);
    });

    it('payInvoice returns null on error', async () => {
      mockWebln.sendPayment = async () => { throw new Error('fail') };
      const provider = new WebLNProvider({ webln: mockWebln });
      await provider.connect();
      const result = await provider.payInvoice('lnbc1000mock');
      assert.equal(result, null);
    });

    it('getInfo returns node info', async () => {
      const provider = new WebLNProvider({ webln: mockWebln });
      await provider.connect();
      const info = await provider.getInfo();
      assert.equal(info.node.alias, 'TestNode');
    });

    it('getInfo returns null on error', async () => {
      mockWebln.getInfo = async () => { throw new Error('fail') };
      const provider = new WebLNProvider({ webln: mockWebln });
      await provider.connect();
      const info = await provider.getInfo();
      assert.equal(info, null);
    });

    it('toJSON reflects connected state', async () => {
      const provider = new WebLNProvider({ webln: mockWebln });
      await provider.connect();
      const json = provider.toJSON();
      assert.equal(json.available, true);
      assert.equal(json.connected, true);
      assert.equal(json.type, 'webln');
    });
  });
});
