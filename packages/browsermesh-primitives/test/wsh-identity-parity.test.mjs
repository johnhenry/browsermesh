// ssh-keys.mjs is the ONE conversion module on the browsermesh side (pod id <-> fingerprint <-> OpenSSH line). wsh's
// `@johnhenry/wsh/identity` (0.49) is the one on the wsh side. This runs both over the same inputs, the valid ones and
// the strictness cases, so that "they name one key the same way" is a test and every place they differ is written down.
//
// `@johnhenry/wsh` is a development dependency of this test only: nothing in this package imports it. Where it is not
// installed the test skips and says why; REQUIRE_WSH_PARITY makes that a failure (the script sets nothing: the root
// devDependency is always installed in a clone, and CI installs it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PodIdentity,
  podIdFromRawKey,
  podIdToFingerprint,
  fingerprintToPodId,
  openSSHPublicKeyFromRaw,
  rawPublicKeyFromOpenSSH,
  authorizedKeysLine,
} from '../src/index.mjs';

let wsh = null;
let wshServer = null;
try {
  wsh = await import('@johnhenry/wsh/identity');
  wshServer = await import('@johnhenry/wsh/server');
} catch { /* not installed: the parity tests skip, saying why */ }
const skip = wsh ? false : 'the development dependency @johnhenry/wsh (0.49 or later, for /identity) is not installed';
if (!wsh && process.env.REQUIRE_WSH_PARITY) throw new Error(`REQUIRE_WSH_PARITY is set but ${skip}`);

// RFC 8032 section 7.1, test 1.
const RAW = Uint8Array.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'.match(/../g), (h) => parseInt(h, 16));
const POD_ID = 'If4x36FUomFia_hUBG_SJxt77UtqvkWqWId-9H-XIbk';
const FINGERPRINT = '21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9';
const LINE = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINdamAGCsQq31Uv+08lkBzoO4XLz2qYjJa8CGmj3B1Ea';
const BLOB = LINE.split(' ')[1];

/** What a function does with an input: its value (bytes as hex) or that it threw a TypeError. */
function run(fn, ...args) {
  try {
    const value = fn(...args);
    return { value: value instanceof Uint8Array ? `bytes:${Buffer.from(value).toString('hex')}` : value };
  } catch (error) {
    assert.ok(error instanceof TypeError, `a refusal is a TypeError, not ${error}`);
    return { refused: true };
  }
}

const URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

test('wsh/identity and ssh-keys.mjs name every key the same way', { skip }, async () => {
  const keys = [RAW, ...await Promise.all(Array.from({ length: 8 }, async () => (await PodIdentity.generate()).rawPublicKey()))];
  for (const raw of keys) {
    const all = await wsh.identityOf(raw);
    assert.equal(await podIdFromRawKey(raw), all.podId);
    assert.equal(podIdToFingerprint(all.podId), all.fingerprint);
    assert.equal(fingerprintToPodId(all.fingerprint), all.podId);
    assert.equal(openSSHPublicKeyFromRaw(raw), all.openssh);
    assert.deepEqual(rawPublicKeyFromOpenSSH(all.openssh), all.raw);
    assert.equal(openSSHPublicKeyFromRaw(raw, { comment: 'pod' }), wsh.rawKeyToOpenSsh(raw, 'pod'));
    assert.deepEqual(wsh.parseOpenSshKey(`${all.openssh} pod`).raw, raw);
    assert.equal(wsh.parseOpenSshKey(`${all.openssh} pod`).comment, 'pod');
  }
  assert.equal((await wsh.identityOf(RAW)).podId, POD_ID);
  assert.equal((await wsh.identityOf(RAW)).fingerprint, FINGERPRINT);
});

test('pod id and fingerprint: the same strictness (exactly 32 bytes, canonical spelling) on every input', { skip }, () => {
  const noncanonical = POD_ID.slice(0, 42) + URL_ALPHABET[URL_ALPHABET.indexOf(POD_ID[42]) ^ 1];
  const podIds = ['', 'AAAA', `${POD_ID}A`, POD_ID.slice(1), `${POD_ID.slice(0, 42)}!`, noncanonical, POD_ID.toUpperCase(), ` ${POD_ID}`, `${POD_ID}\n`, POD_ID.replaceAll('-', '+'), 7, null, undefined, {}, POD_ID];
  for (const input of podIds) assert.deepEqual(run(podIdToFingerprint, input), run(wsh.podIdToFingerprint, input), `podId ${JSON.stringify(input)}`);
  const fingerprints = ['', 'ab', FINGERPRINT.slice(2), `${FINGERPRINT}00`, `${FINGERPRINT.slice(0, 63)}g`, FINGERPRINT.toUpperCase(), ` ${FINGERPRINT}`, `${FINGERPRINT}\n`, `0x${FINGERPRINT.slice(2)}`, 7, null, undefined, FINGERPRINT];
  for (const input of fingerprints) assert.deepEqual(run(fingerprintToPodId, input), run(wsh.fingerprintToPodId, input), `fingerprint ${JSON.stringify(input)}`);
  // and the refusals are real ones, on both sides
  assert.equal(run(podIdToFingerprint, noncanonical).refused, true);
  assert.equal(run(wsh.podIdToFingerprint, noncanonical).refused, true);
  assert.equal(run(fingerprintToPodId, FINGERPRINT.slice(2)).refused, true);
});

test('OpenSSH key lines: the same refusals, and the two places the two readers differ are the ones written here', { skip }, () => {
  const neighbour = BLOB.slice(0, -1) + 'A';
  const other = (blob) => `ssh-ed25519 ${Buffer.from(blob).toString('base64')}`;
  const shared = [
    LINE, `${LINE} comment`, `${LINE} two words`, `${LINE}  `,
    `ssh-rsa ${BLOB}`, `restrict ${LINE}`, `capabilities="exec" ${LINE}`, 'ssh-ed25519', `ssh-ed25519 ${BLOB.slice(0, 60)}`, `ssh-ed25519 ${BLOB}AAAA`, `ssh-ed25519 ${'!'.repeat(68)}`,
    `${LINE}\nssh-ed25519 ${BLOB}`, `${LINE} a\u0007b`, `${LINE}\r\n${LINE}`, `${neighbour.length === 68 ? `ssh-ed25519 ${neighbour}` : LINE}`,
    other(Uint8Array.from([0, 0, 0, 11, ...Buffer.from('ssh-ed25518'), 0, 0, 0, 32, ...RAW])),
    other(Uint8Array.from([0, 0, 0, 11, ...Buffer.from('ssh-ed25519'), 0, 0, 0, 31, ...RAW.slice(1), 0])),
    7, null, undefined, '',
  ];
  for (const input of shared) {
    const ours = run(rawPublicKeyFromOpenSSH, input);
    const theirs = run(wsh.openSshToRawKey, input);
    // Both refuse, or both read the same key.
    assert.deepEqual(ours, theirs, `line ${JSON.stringify(input)}`);
  }
  // The known differences, both ways. Neither reads a different KEY than the other; they differ in whether a line with
  // surrounding whitespace is a line at all.
  //  - ssh-keys.mjs reads a line with leading blanks or a trailing tab (what an authorized_keys file may hold); wsh/identity
  //    refuses both (it takes trailing spaces).
  //  - wsh/identity reads a line with ONE trailing line break; ssh-keys.mjs refuses any control character.
  const oursOnly = [`  ${LINE}`, `\t${LINE}\t`, ` ${LINE} comment`, `${LINE}\t`];
  for (const input of oursOnly) {
    assert.equal(run(rawPublicKeyFromOpenSSH, input).value, `bytes:${Buffer.from(RAW).toString('hex')}`, JSON.stringify(input));
    assert.equal(run(wsh.openSshToRawKey, input).refused, true, JSON.stringify(input));
  }
  const wshOnly = [`${LINE}\n`, `${LINE} comment\n`];
  for (const input of wshOnly) {
    assert.equal(run(rawPublicKeyFromOpenSSH, input).refused, true, JSON.stringify(input));
    assert.equal(run(wsh.openSshToRawKey, input).value, `bytes:${Buffer.from(RAW).toString('hex')}`, JSON.stringify(input));
  }
});

test('comments: what ssh-keys.mjs writes, wsh reads; ssh-keys.mjs is the stricter writer (printable ASCII, no padding)', { skip }, () => {
  for (const comment of ['', 'pod', 'alice@laptop', 'a b c']) assert.equal(openSSHPublicKeyFromRaw(RAW, { comment }), wsh.rawKeyToOpenSsh(RAW, comment), JSON.stringify(comment));
  // Refused by both: a line break and other control characters.
  for (const comment of ['two\nlines', 'a\u0007b', 'a\rb']) {
    assert.equal(run(openSSHPublicKeyFromRaw, RAW, { comment }).refused, true, JSON.stringify(comment));
    assert.equal(run(wsh.rawKeyToOpenSsh, RAW, comment).refused, true, JSON.stringify(comment));
  }
  // Refused here and accepted by wsh: padding, non-ASCII, longer than 256. (Nothing here is written that wsh cannot read.)
  for (const comment of [' padded ', 'é', 'x'.repeat(300)]) {
    assert.equal(run(openSSHPublicKeyFromRaw, RAW, { comment }).refused, true, JSON.stringify(comment).slice(0, 20));
    assert.equal(run(wsh.rawKeyToOpenSsh, RAW, comment).refused, undefined, JSON.stringify(comment).slice(0, 20));
  }
});

test('authorized_keys lines: what ssh-keys.mjs writes, wsh writes and reads the same; the differences are the ones written here', { skip }, async () => {
  const same = [
    { capabilities: ['objects:app:get', 'mcp:search'], expires: '2030-01-01T00:00:00Z', comment: 'pod' },
    { capabilities: [] },
    { capabilities: ['exec'], expires: new Date('2030-01-01T00:00:00.999Z') },
    { capabilities: ['exec'], expires: Date.UTC(2030, 0, 1) },
    { capabilities: ['gateway:tcp:db.internal:5432', 'unix:/var/run/app.sock', 'fs:read'] },
    { capabilities: ['objects:app', 'objects:*:get', 'mcp:*'], comment: 'x y' },
  ];
  for (const options of same) {
    const ours = authorizedKeysLine({ rawPublicKey: RAW, ...options });
    assert.equal(ours, wsh.authorizedKeyLine(RAW, options), JSON.stringify(options));
    const { entries, refused } = await wshServer.parseAuthorizedKeyEntries(ours);
    assert.deepEqual(refused, []);
    assert.deepEqual(new Uint8Array(entries[0].key), RAW);
    assert.deepEqual(entries[0].permissions.capabilities, options.capabilities);
  }
  // An expiry written with an offset is the same instant; wsh writes it in UTC and this keeps the offset.
  const offset = { capabilities: ['exec'], expires: '2030-01-01T01:00:00+01:00' };
  const [mine, theirs] = [authorizedKeysLine({ rawPublicKey: RAW, ...offset }), wsh.authorizedKeyLine(RAW, offset)];
  assert.notEqual(mine, theirs);
  const expiry = async (line) => (await wshServer.parseAuthorizedKeyEntries(line)).entries[0].permissions.expires;
  assert.equal(await expiry(mine), await expiry(theirs));

  // Refused by both.
  const bad = [{}, { capabilities: undefined }, { capabilities: ['exec'], comment: 'x\nssh-ed25519 AAAA' }, { capabilities: ['exec'], expires: 'tomorrow' }, { capabilities: ['exec'], expires: '2030-01-01' }, { capabilities: ['a"b'] }, { capabilities: ['a,b'] }];
  for (const options of bad) {
    assert.equal(run(authorizedKeysLine, { rawPublicKey: RAW, ...options }).refused, true, JSON.stringify(options));
    assert.equal(run(wsh.authorizedKeyLine, RAW, options).refused, true, JSON.stringify(options));
  }
  assert.equal(run(authorizedKeysLine, { rawPublicKey: RAW.slice(1), capabilities: [] }).refused, true);
  assert.equal(run(wsh.authorizedKeyLine, RAW.slice(1), { capabilities: [] }).refused, true);

  // Written down: wsh checks the capability list against its notation (an unknown or malformed entry is refused), and this
  // writer does not (the vocabulary is the host's, and a host refuses the whole key for an entry it does not know: it fails closed).
  // wsh keeps a capability listed twice; this refuses it. wsh takes a capability list as a string; this wants an array.
  for (const capabilities of [['bogus'], ['objects:']]) {
    assert.equal(run(authorizedKeysLine, { rawPublicKey: RAW, capabilities }).refused, undefined, JSON.stringify(capabilities));
    assert.equal(run(wsh.authorizedKeyLine, RAW, { capabilities }).refused, true, JSON.stringify(capabilities));
  }
  assert.equal(run(authorizedKeysLine, { rawPublicKey: RAW, capabilities: ['exec', 'exec'] }).refused, true);
  assert.equal(run(wsh.authorizedKeyLine, RAW, { capabilities: ['exec', 'exec'] }).refused, undefined);
  assert.equal(run(authorizedKeysLine, { rawPublicKey: RAW, capabilities: 'exec' }).refused, true);
  assert.equal(run(wsh.authorizedKeyLine, RAW, { capabilities: 'exec' }).refused, undefined);
});
