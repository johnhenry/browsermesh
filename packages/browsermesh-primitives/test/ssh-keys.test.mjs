import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PodIdentity,
  podIdFromRawKey,
  podIdToFingerprint,
  fingerprintToPodId,
  openSSHPublicKeyFromRaw,
  rawPublicKeyFromOpenSSH,
  podIdFromOpenSSHPublicKey,
  authorizedKeysLine,
} from '../src/index.mjs';

// RFC 8032 section 7.1, test 1: a public key, with the three names the same bytes have.
const RAW_HEX = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const RAW = Uint8Array.from(RAW_HEX.match(/../g), (h) => parseInt(h, 16));
const POD_ID = 'If4x36FUomFia_hUBG_SJxt77UtqvkWqWId-9H-XIbk';
const FINGERPRINT = '21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9';
const LINE = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINdamAGCsQq31Uv+08lkBzoO4XLz2qYjJa8CGmj3B1Ea';

let wsh = null;
let wshServer = null;
try {
  wsh = await import('@johnhenry/wsh');
  wshServer = await import('@johnhenry/wsh/server');
} catch { /* not installed: the parity tests skip, saying why */ }
const skipParity = wsh ? false : 'the development dependency @johnhenry/wsh is not installed';
if (!wsh && process.env.REQUIRE_WSH_PARITY) throw new Error(`REQUIRE_WSH_PARITY is set but ${skipParity}`);

test('one key, three names: the pod id, wsh\'s hex fingerprint and the OpenSSH line', async () => {
  assert.equal(await podIdFromRawKey(RAW), POD_ID);
  assert.equal(podIdToFingerprint(POD_ID), FINGERPRINT);
  assert.equal(fingerprintToPodId(FINGERPRINT), POD_ID);
  assert.equal(fingerprintToPodId(FINGERPRINT.toUpperCase()), POD_ID);
  assert.equal(openSSHPublicKeyFromRaw(RAW), LINE);
  assert.deepEqual(rawPublicKeyFromOpenSSH(LINE), RAW);
  assert.equal(await podIdFromOpenSSHPublicKey(LINE), POD_ID);
  assert.equal(await podIdFromOpenSSHPublicKey(`${LINE} alice@laptop`), POD_ID);
  assert.equal(openSSHPublicKeyFromRaw(RAW, { comment: 'alice@laptop' }), `${LINE} alice@laptop`);
});

test('PodIdentity exports its public key line, and nothing is done unless asked', async () => {
  const id = await PodIdentity.generate();
  const line = await id.toOpenSSHPublicKey();
  assert.match(line, /^ssh-ed25519 [A-Za-z0-9+/]{68}$/);
  assert.equal(await podIdFromOpenSSHPublicKey(line), id.podId);
  assert.equal(await id.toOpenSSHPublicKey({ comment: 'pod' }), `${line} pod`);
  // A key this page cannot read still has a public key line: only the public key is touched.
  const sealed = await PodIdentity.generate({ extractable: false });
  assert.equal(await podIdFromOpenSSHPublicKey(await sealed.toOpenSSHPublicKey()), sealed.podId);
});

test('conversions are strict: a pod id and a fingerprint are exactly 32 bytes', () => {
  for (const bad of ['', 'AAAA', `${POD_ID}A`, POD_ID.slice(1), `${POD_ID.slice(0, 42)}!`, 7, null, undefined]) {
    assert.throws(() => podIdToFingerprint(bad), TypeError, String(bad));
  }
  // The last character carries two unused bits: a pod id that sets them is not the canonical encoding.
  const urlAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const noncanonical = POD_ID.slice(0, 42) + urlAlphabet[urlAlphabet.indexOf(POD_ID[42]) ^ 1];
  assert.throws(() => podIdToFingerprint(noncanonical), TypeError);
  for (const bad of ['', 'ab', FINGERPRINT.slice(2), `${FINGERPRINT}00`, `${FINGERPRINT.slice(0, 63)}g`, 7, null]) {
    assert.throws(() => fingerprintToPodId(bad), TypeError, String(bad));
  }
});

test('a public key line must be exactly one ssh-ed25519 key', () => {
  const blob = LINE.split(' ')[1];
  const refused = [
    ['another key type', `ssh-rsa ${blob}`],
    ['options in front', `restrict ${LINE}`],
    ['options with a capability in front', `capabilities="exec" ${LINE}`],
    ['no key', 'ssh-ed25519'],
    ['a short blob', `ssh-ed25519 ${blob.slice(0, 60)}`],
    ['a long blob', `ssh-ed25519 ${blob}AAAA`],
    ['not base64', `ssh-ed25519 ${'!'.repeat(68)}`],
    ['a line break inside', `${LINE}\nssh-ed25519 ${blob}`],
    ['a trailing line break', `${LINE}\n`],
    ['a control character in the comment', `${LINE} a\u0007b`],
    ['a blob that names another type', `ssh-ed25519 ${Buffer.from(Uint8Array.from([0, 0, 0, 11, ...Buffer.from('ssh-ed25518'), 0, 0, 0, 32, ...RAW])).toString('base64')}`],
    ['a blob with another key length', `ssh-ed25519 ${Buffer.from(Uint8Array.from([0, 0, 0, 11, ...Buffer.from('ssh-ed25519'), 0, 0, 0, 31, ...RAW.slice(1), 0])).toString('base64')}`],
    ['not a string', 7],
  ];
  for (const [what, line] of refused) assert.throws(() => rawPublicKeyFromOpenSSH(line), TypeError, what);
  // 51 bytes fill 68 base64 characters exactly: there are no spare bits for a second spelling of one key.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const neighbour = blob.slice(0, -1) + alphabet[alphabet.indexOf(blob[blob.length - 1]) ^ 1];
  assert.notDeepEqual(rawPublicKeyFromOpenSSH(`ssh-ed25519 ${neighbour}`), RAW);
  assert.throws(() => openSSHPublicKeyFromRaw(RAW.slice(1)), TypeError);
  assert.throws(() => openSSHPublicKeyFromRaw(RAW, { comment: 'two\nlines' }), TypeError);
  assert.throws(() => openSSHPublicKeyFromRaw(RAW, { comment: ' padded ' }), TypeError);
});

test('an authorized_keys line carries capabilities (required) and expiry, and cannot be made to say more', async () => {
  const line = authorizedKeysLine({ rawPublicKey: RAW, capabilities: ['objects:app:get', 'mcp:search'], expires: '2030-01-01T00:00:00Z', comment: 'pod' });
  assert.equal(line, `capabilities="objects:app:get,mcp:search",expires="2030-01-01T00:00:00Z" ${LINE} pod`);
  assert.equal(authorizedKeysLine({ rawPublicKey: RAW, capabilities: [] }), `capabilities="" ${LINE}`);
  assert.equal(authorizedKeysLine({ rawPublicKey: RAW, capabilities: ['exec'], expires: new Date('2030-01-01T00:00:00.999Z') }), `capabilities="exec",expires="2030-01-01T00:00:00Z" ${LINE}`);
  assert.equal(authorizedKeysLine({ rawPublicKey: RAW, capabilities: ['exec'], expires: Date.UTC(2030, 0, 1) }), `capabilities="exec",expires="2030-01-01T00:00:00Z" ${LINE}`);
  assert.equal(authorizedKeysLine({ rawPublicKey: RAW, capabilities: ['exec'], expires: '2030-01-01T01:00:00+01:00' }), `capabilities="exec",expires="2030-01-01T01:00:00+01:00" ${LINE}`);

  // Without capabilities the line would allow everything the host's other options allow: it is not written.
  for (const capabilities of [undefined, null, 'exec', {}]) assert.throws(() => authorizedKeysLine({ rawPublicKey: RAW, capabilities }), /capabilities is required/);
  // Nothing that could end the option, start another or end the line gets in.
  for (const bad of ['a"b', 'a,b', 'a b', 'a\nb', 'a\rb', 'a\\b', 'a\tb', 'a b', 'é', '', 'x'.repeat(257), 7, null]) {
    assert.throws(() => authorizedKeysLine({ rawPublicKey: RAW, capabilities: [bad] }), TypeError, JSON.stringify(bad));
  }
  assert.throws(() => authorizedKeysLine({ rawPublicKey: RAW, capabilities: ['exec', 'exec'] }), TypeError);
  assert.throws(() => authorizedKeysLine({ rawPublicKey: RAW, capabilities: ['exec'], comment: 'x\nssh-ed25519 AAAA' }), TypeError);
  assert.throws(() => authorizedKeysLine({ rawPublicKey: RAW, capabilities: ['exec'], expires: 'tomorrow' }), TypeError);
  assert.throws(() => authorizedKeysLine({ rawPublicKey: RAW, capabilities: ['exec'], expires: '2030-01-01' }), TypeError);
  assert.throws(() => authorizedKeysLine({ rawPublicKey: RAW, capabilities: ['exec'], expires: Number.NaN }), TypeError);
  assert.throws(() => authorizedKeysLine({ rawPublicKey: RAW.slice(1), capabilities: [] }), TypeError);

  const id = await PodIdentity.generate();
  const viaIdentity = await id.toAuthorizedKeysLine({ capabilities: ['mcp:search'], comment: 'pod' });
  assert.equal(viaIdentity, authorizedKeysLine({ rawPublicKey: await id.rawPublicKey(), capabilities: ['mcp:search'], comment: 'pod' }));
  await assert.rejects(id.toAuthorizedKeysLine(), TypeError);
});

// ── parity with wsh (a development dependency of this test only) ────────────

test('wsh agrees on every conversion', { skip: skipParity }, async () => {
  const keys = [RAW, ...await Promise.all(Array.from({ length: 8 }, async () => (await PodIdentity.generate()).rawPublicKey()))];
  for (const raw of keys) {
    const podId = await wsh.podId(raw);
    const fingerprint = await wsh.fingerprint(raw);
    assert.equal(await podIdFromRawKey(raw), podId);
    assert.equal(podIdToFingerprint(podId), fingerprint);
    assert.equal(wsh.podIdToFingerprint(podId), fingerprint);
    assert.equal(fingerprintToPodId(fingerprint), podId);
    assert.equal(wsh.fingerprintToPodId(fingerprint), podId);
    assert.equal(fingerprintToPodId(fingerprint.toUpperCase()), wsh.fingerprintToPodId(fingerprint.toUpperCase()));
    const line = await wsh.exportPublicKeySSH(await wsh.importPublicKeyRaw(raw));
    assert.equal(openSSHPublicKeyFromRaw(raw), line);
    const parsed = wsh.parseSSHPublicKey(`${line} comment`);
    assert.deepEqual(wsh.extractRawFromSSHWire(parsed.data), raw);
    assert.deepEqual(rawPublicKeyFromOpenSSH(`${line} comment`), raw);
    assert.equal(await podIdFromOpenSSHPublicKey(line), podId);
  }
});

test('wsh\'s authorized_keys parser reads our line back as written, and refuses nothing', { skip: skipParity }, async () => {
  const id = await PodIdentity.generate();
  const raw = await id.rawPublicKey();
  const cases = [
    { capabilities: ['objects:app:get', 'mcp:search'], expires: '2030-01-01T00:00:00Z', epoch: 1893456000 },
    { capabilities: [], expires: undefined, epoch: null },
    { capabilities: ['gateway:tcp:db.internal:5432', 'unix:/var/run/app.sock', 'fs:read'], expires: new Date('2031-06-01T12:30:45Z'), epoch: Date.UTC(2031, 5, 1, 12, 30, 45) / 1000 },
  ];
  for (const { capabilities, expires, epoch } of cases) {
    const line = await id.toAuthorizedKeysLine({ capabilities, expires, comment: 'pod' });
    const { entries, refused } = await wshServer.parseAuthorizedKeyEntries(line);
    assert.deepEqual(refused, [], line);
    assert.equal(entries.length, 1);
    assert.deepEqual(new Uint8Array(entries[0].key), raw);
    assert.deepEqual(entries[0].permissions.capabilities, capabilities);
    assert.equal(entries[0].permissions.expires, epoch);
  }
});
