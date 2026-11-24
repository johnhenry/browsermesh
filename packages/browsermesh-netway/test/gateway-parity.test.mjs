/**
 * netway mirrors two things from wsh by hand: the GatewayFail code table (`GATEWAY_ERROR`) and
 * the gateway opcodes `GatewayBackend` writes as bare numbers. This file proves the copies
 * equal wsh's.
 *
 * - Opcodes: `MSG` is a public export of `@johnhenry/wsh`, compared directly.
 * - Error codes: as of wsh 0.48 the table (`GATEWAY_FAIL`) is a constant inside the host's
 *   source and is not exported. This test uses the public export when a wsh release has one
 *   (`@johnhenry/wsh/server`), and otherwise reads the same constant from the installed
 *   package's own source file. The behaviour of each code that a host can be made to
 *   produce is also checked against a real host in gateway-real-wsh.test.mjs.
 *   If neither source is reachable the test skips and says why.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GATEWAY_ERROR } from '../src/constants.mjs';

let wsh = null;
try { wsh = await import('@johnhenry/wsh'); } catch { /* skipped below */ }

/** wsh's GatewayFail table and where it came from, or `{ reason }` when it cannot be reached. */
async function wshGatewayFailTable() {
  try {
    const server = await import('@johnhenry/wsh/server');
    if (server.GATEWAY_FAIL) return { table: server.GATEWAY_FAIL, from: '@johnhenry/wsh/server' };
  } catch { /* no server entry: fall through */ }
  try {
    const entry = import.meta.resolve('@johnhenry/wsh/server');
    const core = await import(new URL('./gateway-core.mjs', entry).href);
    if (core.GATEWAY_FAIL) return { table: core.GATEWAY_FAIL, from: 'server/gateway-core.mjs of the installed package' };
  } catch { /* not found */ }
  return { reason: 'the installed @johnhenry/wsh exports no GatewayFail table and its source file is not reachable' };
}

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

describe('netway and wsh agree on the gateway wire values', { skip: wsh ? false : '@johnhenry/wsh is not installed' }, () => {
  it('every gateway opcode netway writes has the value wsh gives that name', () => {
    for (const [name, value] of Object.entries(BACKEND_OPCODES)) {
      assert.equal(wsh.MSG[name], value, `MSG.${name}`);
    }
  });

  it('GATEWAY_ERROR equals wsh\'s GatewayFail table, name for name', async (t) => {
    const found = await wshGatewayFailTable();
    if (found.reason) { t.skip(found.reason); return; }
    assert.deepEqual({ ...GATEWAY_ERROR }, { ...found.table }, `compared with ${found.from}`);
  });

  it('the table has distinct, positive integer codes', () => {
    const values = Object.values(GATEWAY_ERROR);
    assert.equal(new Set(values).size, values.length);
    assert.ok(values.every((v) => Number.isInteger(v) && v > 0));
  });
});
