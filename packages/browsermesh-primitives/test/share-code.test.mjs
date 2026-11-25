import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PodIdentity,
  derivePodId,
  podIdToFingerprint,
  SHARE_CODE_CHARS,
  SHARE_FINGERPRINT_CHARS,
  SHARE_FINGERPRINT_BITS,
  generateShareCode,
  shareFingerprintOfPodId,
  shareFingerprintOfPublicKey,
  podIdMatchesShareFingerprint,
  publicKeyMatchesShareFingerprint,
  normalizeShareCode,
  normalizeShareFingerprint,
  formatShareCode,
  formatShareFingerprint,
  formatShare,
  parseShareInput,
  sanitizeLabel,
} from '../src/index.mjs';

// RFC 8032 section 7.1, test 1: a public key whose pod id and hex fingerprint are known (see ssh-keys.test.mjs).
const RAW = Uint8Array.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'.match(/../g), (h) => parseInt(h, 16));
const POD_ID = 'If4x36FUomFia_hUBG_SJxt77UtqvkWqWId-9H-XIbk';
const HEX = '21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9';
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** The expected fingerprint, worked out a different way: the first 35 hex digits (140 bits) as a number, in base 32. */
function expectedFingerprint(hex) {
  let n = BigInt('0x' + hex.slice(0, 35));
  let out = '';
  for (let i = 0; i < 28; i++) { out = ALPHABET[Number(n % 32n)] + out; n /= 32n; }
  return out;
}
const FP = expectedFingerprint(HEX);
const CODE = 'K7QM2XPD9TNR';

test('size: 12 characters of code (60 bits), 28 of fingerprint (140 bits)', () => {
  assert.equal(SHARE_CODE_CHARS, 12);
  assert.equal(SHARE_FINGERPRINT_CHARS, 28);
  assert.equal(SHARE_FINGERPRINT_BITS, 140);
});

test('the fingerprint is the first 140 bits of the pod id\'s own hash, not a second hash', async () => {
  assert.equal(podIdToFingerprint(POD_ID), HEX); // the pod id is that hash
  assert.equal(shareFingerprintOfPodId(POD_ID), FP);
  assert.equal(await shareFingerprintOfPublicKey(RAW), FP);
});

test('a generated identity: from its pod id, its raw key and its CryptoKey, all the same', async () => {
  const id = await PodIdentity.generate();
  const fp = shareFingerprintOfPodId(id.podId);
  assert.match(fp, /^[0-9A-HJKMNP-TV-Z]{28}$/);
  assert.equal(await shareFingerprintOfPublicKey(await id.rawPublicKey()), fp);
  assert.equal(await shareFingerprintOfPublicKey(id.keyPair.publicKey), fp);
  assert.equal(await derivePodId(id.keyPair.publicKey), id.podId);
});

test('shareFingerprintOfPodId refuses anything that is not a canonical pod id', () => {
  for (const bad of ['', 'short', POD_ID + 'A', POD_ID.slice(0, 42), POD_ID.replace('I', '!'), null, undefined, 5, {}]) {
    assert.throws(() => shareFingerprintOfPodId(bad), TypeError, String(bad));
  }
  // 43 characters whose last one carries bits beyond 256: not canonical
  assert.throws(() => shareFingerprintOfPodId(POD_ID.slice(0, 42) + 'l'), TypeError);
});

test('podIdMatchesShareFingerprint compares all 140 bits', () => {
  assert.equal(podIdMatchesShareFingerprint(POD_ID, FP), true);
  assert.equal(podIdMatchesShareFingerprint(POD_ID, formatShareFingerprint(FP).toLowerCase()), true);
  // differs only in the last character (the last 5 bits of the 140)
  const last = FP.at(-1) === '0' ? '1' : '0';
  assert.equal(podIdMatchesShareFingerprint(POD_ID, FP.slice(0, 27) + last), false);
  // the first 20 characters right, the rest not: a prefix is not enough
  assert.equal(podIdMatchesShareFingerprint(POD_ID, FP.slice(0, 20) + (FP.slice(20) === '0'.repeat(8) ? '1'.repeat(8) : '0'.repeat(8))), false);
  // another key
  assert.equal(podIdMatchesShareFingerprint('A'.repeat(43), FP), false);
});

test('podIdMatchesShareFingerprint answers false, never throws, for input that is not a pod id or a fingerprint', () => {
  for (const [p, f] of [['x', FP], [POD_ID, 'x'], [POD_ID, ''], [null, FP], [POD_ID, null], [POD_ID, FP + FP], [POD_ID, FP.slice(1)]]) {
    assert.equal(podIdMatchesShareFingerprint(p, f), false);
  }
});

test('publicKeyMatchesShareFingerprint', async () => {
  assert.equal(await publicKeyMatchesShareFingerprint(RAW, FP), true);
  const other = await PodIdentity.generate();
  assert.equal(await publicKeyMatchesShareFingerprint(await other.rawPublicKey(), FP), false);
  assert.equal(await publicKeyMatchesShareFingerprint(RAW, 'nonsense'), false);
});

test('generateShareCode: 12 characters from the alphabet, from the injected source, no modulo bias', () => {
  const bytes = Uint8Array.from({ length: 12 }, (_, i) => i * 21 + 7); // any byte; only the low 5 bits count
  const code = generateShareCode(() => bytes);
  assert.equal(code.length, 12);
  assert.equal(code, Array.from(bytes, (b) => ALPHABET[b & 31]).join(''));
  const real = generateShareCode();
  assert.match(real, /^[0-9A-HJKMNP-TV-Z]{12}$/);
  assert.notEqual(real, generateShareCode());
  assert.throws(() => generateShareCode(() => new Uint8Array(3)), TypeError);
});

test('format: grouped in fours, joined by a dot; the link carries exactly that', () => {
  assert.equal(formatShareCode(CODE), 'K7QM-2XPD-9TNR');
  assert.equal(formatShareFingerprint(FP), FP.match(/.{4}/g).join('-'));
  const s = formatShare({ code: CODE, fingerprint: FP, origin: 'https://app.example' });
  assert.equal(s.code, `K7QM-2XPD-9TNR.${FP.match(/.{4}/g).join('-')}`);
  assert.equal(s.url, `https://app.example/?join=${s.code}`);
  assert.equal(formatShare({ code: CODE, fingerprint: FP, linkBase: 'https://h.example/app' }).url, `https://h.example/app/?join=${s.code}`);
  assert.equal(formatShare({ code: CODE, fingerprint: FP, origin: 'https://a.example///' }).url, `https://a.example/?join=${s.code}`);
  assert.equal(formatShare({ code: CODE, fingerprint: FP, linkBase: 'https://h.example/app///' }).url, `https://h.example/app/?join=${s.code}`);
  assert.equal(formatShare({ code: CODE, fingerprint: FP }).url, `/?join=${s.code}`);
  assert.equal(formatShare({ code: CODE, fingerprint: FP, linkBase: '/'.repeat(100_000) }).url, `/?join=${s.code}`);
  assert.throws(() => formatShare({ code: 'short', fingerprint: FP }), TypeError);
  assert.throws(() => formatShare({ code: CODE, fingerprint: 'short' }), TypeError);
});

test('parse: the full code in any case and spacing, and the link in its forms', () => {
  const { code, url } = formatShare({ code: CODE, fingerprint: FP, origin: 'https://app.example' });
  const want = { ok: true, code: CODE, fingerprint: FP };
  assert.deepEqual(parseShareInput(code), want);
  assert.deepEqual(parseShareInput(code.toLowerCase()), want);
  assert.deepEqual(parseShareInput(`  ${code.replace(/-/g, ' ')}\n`), want);
  assert.deepEqual(parseShareInput(url), want);
  assert.deepEqual(parseShareInput(url.replace('?join=', '#join=')), want);
  assert.deepEqual(parseShareInput(`https://x.example/?a=1&join=${encodeURIComponent(code)}&b=2`), want);
  assert.deepEqual(parseShareInput(`${CODE}.${FP}`), want);
});

test('parse: typo tolerance (I and L read as 1, O as 0)', () => {
  const typo = `KOIL-2XPD-9TNR.${FP.replace(/1/g, 'L').replace(/0/g, 'O')}`;
  assert.deepEqual(parseShareInput(typo), { ok: true, code: 'K0112XPD9TNR', fingerprint: FP });
});

test('parse: the short half alone is refused, and the message says what to ask for', () => {
  for (const bare of [CODE, 'K7QM-2XPD-9TNR', `${CODE}.`, `K7QM-2XPD-9TNR.  `, `https://app.example/?join=${CODE}`]) {
    const r = parseShareInput(bare);
    assert.equal(r.ok, false, bare);
    assert.equal(r.reason, 'no-fingerprint', bare);
    assert.match(r.message, /only the short part/);
    assert.match(r.message, /Ask for the full share code or the link/);
  }
});

test('parse: other refusals, each with its own reason; it never throws', () => {
  assert.equal(parseShareInput('').reason, 'empty');
  assert.equal(parseShareInput('   ').reason, 'empty');
  assert.equal(parseShareInput(undefined).reason, 'empty');
  assert.equal(parseShareInput('not a code at all').reason, 'invalid');
  assert.equal(parseShareInput('K7QM-2XPD-9TN').reason, 'invalid'); // short half too short
  assert.equal(parseShareInput(`${CODE}.${FP.slice(0, 27)}`).reason, 'bad-fingerprint'); // cut short
  assert.equal(parseShareInput(`${CODE}.${FP}X`).reason, 'bad-fingerprint'); // too long
  assert.equal(parseShareInput(`${CODE}.${FP.slice(0, 27)}U`).reason, 'bad-fingerprint'); // U is not in the alphabet
  assert.equal(parseShareInput(`${CODE}.${FP}.${FP}`).reason, 'bad-fingerprint');
  assert.equal(parseShareInput('https://x/?join=%E0%A4%A').ok, false); // bad percent-encoding
  for (const odd of [null, 5, {}, []]) assert.equal(parseShareInput(odd).ok, false);
  assert.equal(parseShareInput('K7QM-2XPD-9TNR.' + 'Z'.repeat(5000)).reason, 'bad-fingerprint');
});

test('normalizers', () => {
  assert.equal(normalizeShareCode('k7qm-2xpd-9tnr'), CODE);
  assert.equal(normalizeShareCode(`K7QM-2XPD-9TNR.${FP}`), CODE, 'the short half of a full code');
  assert.equal(normalizeShareCode('nope'), null);
  assert.equal(normalizeShareCode(5), null);
  assert.equal(normalizeShareFingerprint(formatShareFingerprint(FP).toLowerCase()), FP);
  assert.equal(normalizeShareFingerprint(FP.slice(1)), null);
  assert.equal(normalizeShareFingerprint(null), null);
});

test('sanitizeLabel: escape sequences, control and invisible characters, whitespace, length', () => {
  assert.equal(sanitizeLabel('My web'), 'My web');
  assert.equal(sanitizeLabel('\u001b[31mred\u001b[0m'), 'red');
  assert.equal(sanitizeLabel('a\u001b]0;title\u0007b'), 'ab');
  assert.equal(sanitizeLabel('a\u001b]0;title\u001b\\b'), 'ab');
  assert.equal(sanitizeLabel('a\u009b31mb'), 'ab');
  assert.equal(sanitizeLabel('x\u0000y\u0007z\u007f'), 'xyz');
  assert.equal(sanitizeLabel('a‮evil‬'), 'aevil', 'bidi controls');
  assert.equal(sanitizeLabel('a​b‍c﻿d'), 'abcd', 'zero width and BOM');
  assert.equal(sanitizeLabel('\u{E0041}tag'), 'tag', 'tag characters');
  assert.equal(sanitizeLabel('a b c'), 'abc', 'line and paragraph separators');
  assert.equal(sanitizeLabel('  a \n\t b   c '), 'a b c');
  assert.equal(sanitizeLabel('lone \ud800 surrogate'), 'lone surrogate');
  assert.equal(sanitizeLabel('é'), 'é', 'NFC');
  assert.equal(sanitizeLabel('x'.repeat(200)).length, 64);
  assert.equal(sanitizeLabel('x'.repeat(200), 10), 'x'.repeat(10));
  assert.equal([...sanitizeLabel('\u{1F600}'.repeat(100))].length, 64, 'counted as code points');
  assert.equal(sanitizeLabel(undefined), '');
  assert.equal(sanitizeLabel(42), '');
  assert.equal(sanitizeLabel({ toString() { return 'x'; } }), '');
});

test('sanitizeLabel of an enormous string is still bounded', () => {
  assert.equal(sanitizeLabel('a'.repeat(5_000_000)).length, 64);
  assert.equal(sanitizeLabel('​'.repeat(5_000_000)), '');
});
