/**
 * netway mirrors two things from wsh by hand: the GatewayFail code table (`GATEWAY_ERROR`) and
 * the gateway opcodes `GatewayBackend` writes as bare numbers. This file proves the copies
 * equal wsh's.
 *
 * - Opcodes: `MSG` is a public export of `@johnhenry/wsh`, compared directly.
 * - Error codes: `GATEWAY_FAIL`, `GATEWAY_FAIL_TABLE` and `gatewayFailName` are public exports of
 *   `@johnhenry/wsh` (0.49 and later). There is no other source and no fallback: where wsh is too
 *   old to export them this fails, it does not read the file. The behaviour of each code that a
 *   host can be made to produce is also checked against a real host in gateway-real-wsh.test.mjs.
 *
 * Code 5 is the one number with two meanings: it is `GATEWAY_DISABLED` (what the Rust wsh-server
 * sends) and also what a Node gateway at wsh 0.51 or earlier sent for a timeout. A timeout from a
 * current Node gateway is `TIMEOUT` = 8. netway has one name for 5 (`GATEWAY_DISABLED`);
 * `GatewayBackend` reads a 5 as "disabled, or a timeout from an older gateway" and puts the host's
 * own message beside the code in the error it throws.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GATEWAY_ERROR } from '../src/constants.mjs';

let wsh = null;
try { wsh = await import('@johnhenry/wsh'); } catch { /* skipped below */ }
const skip = wsh?.GATEWAY_FAIL_TABLE ? false : '@johnhenry/wsh 0.49 or later (which exports GATEWAY_FAIL_TABLE) is not installed';
if (skip && process.env.REQUIRE_WSH_PARITY) throw new Error(`REQUIRE_WSH_PARITY is set but ${skip}`);

/** The opcodes gateway-backend.mjs sends and handles, by wsh's names. */
const BACKEND_OPCODES = Object.freeze({
  OPEN_TCP: 0x70,
  OPEN_UDP: 0x71,
  RESOLVE_DNS: 0x72,
  GATEWAY_OK: 0x73,
  GATEWAY_FAIL: 0x74,
  GATEWAY_CLOSE: 0x75,
  INBOUND_OPEN: 0x76,
  INBOUND_ACCEPT: 0x77,
  INBOUND_REJECT: 0x78,
  DNS_RESULT: 0x79,
  LISTEN_REQUEST: 0x7a,
  LISTEN_OK: 0x7b,
  LISTEN_FAIL: 0x7c,
  LISTEN_CLOSE: 0x7d,
  GATEWAY_DATA: 0x7e,
});

describe('netway and wsh agree on the gateway wire values', { skip }, () => {
  it('every gateway opcode netway writes has the value wsh gives that name', () => {
    for (const [name, value] of Object.entries(BACKEND_OPCODES)) {
      assert.equal(wsh.MSG[name], value, `MSG.${name}`);
    }
  });

  it('GATEWAY_ERROR equals wsh\'s GATEWAY_FAIL, name for name and number for number', () => {
    assert.deepEqual({ ...GATEWAY_ERROR }, { ...wsh.GATEWAY_FAIL });
  });

  it('and equals what wsh\'s table lists, every code once', () => {
    const fromTable = Object.fromEntries(wsh.GATEWAY_FAIL_TABLE.map(({ name, code }) => [name, code]));
    assert.deepEqual({ ...GATEWAY_ERROR }, fromTable);
    assert.equal(new Set(wsh.GATEWAY_FAIL_TABLE.map((row) => row.code)).size, wsh.GATEWAY_FAIL_TABLE.length);
    for (const row of wsh.GATEWAY_FAIL_TABLE) assert.ok(row.meaning.length > 0, `${row.name} has a meaning`);
  });

  it('wsh names every code netway names the same way (gatewayFailName)', () => {
    for (const [name, code] of Object.entries(GATEWAY_ERROR)) assert.equal(wsh.gatewayFailName(code), name);
    assert.equal(wsh.gatewayFailName(99), null);
  });

  it('a code wsh gives a second name has ONE name here, and that is written down: 5 is "gateway disabled", or a timeout from an older Node gateway', () => {
    const twoNames = wsh.GATEWAY_FAIL_TABLE.filter((row) => row.alsoSentAs?.length);
    // If wsh ever gives another code a second meaning, this fails and the docs of GATEWAY_ERROR must say so.
    assert.deepEqual(twoNames.map((row) => [row.name, row.code, ...row.alsoSentAs]), [['GATEWAY_DISABLED', 5, 'TIMEOUT']]);
    assert.equal(GATEWAY_ERROR.GATEWAY_DISABLED, 5);
    assert.equal(GATEWAY_ERROR.TIMEOUT, 8);
    assert.equal(Object.values(GATEWAY_ERROR).filter((code) => code === 5).length, 1, 'no second name for 5 in netway: it is GATEWAY_DISABLED, read with the older-timeout caveat');
  });

  it('the one code a client gives its own error without asking the host (UNSUPPORTED, 0) is not a wire code and is not in GATEWAY_ERROR', () => {
    assert.deepEqual({ ...wsh.GATEWAY_FAIL_LOCAL }, { UNSUPPORTED: 0 });
    assert.equal(Object.values(GATEWAY_ERROR).includes(0), false);
  });

  it('the table has distinct, positive integer codes', () => {
    const values = Object.values(GATEWAY_ERROR);
    assert.equal(new Set(values).size, values.length);
    assert.ok(values.every((v) => Number.isInteger(v) && v > 0));
  });
});
