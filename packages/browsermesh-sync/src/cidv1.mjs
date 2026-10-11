/**
 * Real IPFS CIDv1 / UnixFS addressing (opt-in, alongside ChunkStore's
 * SHA-256-hex "cid").
 *
 * Layout parameters match `ipfs add -r --cid-version=1 --raw-leaves` and the
 * defaults of `ipfs-unixfs-importer`: fixed-size 256 KiB chunker, balanced
 * DAG layout with at most 174 links per node, raw leaves (codec 0x55),
 * dag-pb (0x70) for file-interior and directory nodes, sha2-256 multihash,
 * base32 lowercase multibase ("b" prefix). Zero dependencies.
 *
 * Limitation: directories are always flat dag-pb nodes. Directories whose
 * serialized node exceeds 256 KiB (IPFS would HAMT-shard them) are rejected.
 */

export const CIDV1_DEFAULTS = Object.freeze({ chunkSize: 262144, maxLinks: 174 });

const CODEC_RAW = 0x55;
const CODEC_DAG_PB = 0x70;
const MH_SHA256 = 0x12;
const MAX_DIR_NODE_BYTES = 256 * 1024;
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
const encoder = new TextEncoder();

async function sha256(data) {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  }
  const { createHash } = await import('node:crypto');
  return new Uint8Array(createHash('sha256').update(data).digest());
}

function base32Encode(bytes) {
  let out = '';
  let bits = 0;
  let acc = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const out = [];
  let bits = 0;
  let acc = 0;
  for (const ch of str) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error('invalid base32 character');
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 255);
      bits -= 8;
    }
    acc &= (1 << bits) - 1;
  }
  return Uint8Array.from(out);
}

function cidFromDigest(codec, digest) {
  const bytes = new Uint8Array(4 + digest.length);
  bytes.set([1, codec, MH_SHA256, digest.length]);
  bytes.set(digest, 4);
  return 'b' + base32Encode(bytes);
}

/**
 * Parse a base32 CIDv1 string with a sha2-256 multihash.
 * @param {string} cid
 * @returns {{version: 1, codec: 'raw'|'dag-pb', codecCode: number, digest: Uint8Array}}
 */
export function parseCid(cid) {
  if (typeof cid !== 'string' || cid[0] !== 'b') throw new Error('unsupported CID: expected base32 CIDv1 ("b" prefix)');
  const bytes = base32Decode(cid.slice(1));
  if (bytes.length !== 36 || bytes[0] !== 1 || bytes[2] !== MH_SHA256 || bytes[3] !== 32) {
    throw new Error('unsupported CID: expected CIDv1 with sha2-256 multihash');
  }
  const codecCode = bytes[1];
  if (codecCode !== CODEC_RAW && codecCode !== CODEC_DAG_PB) throw new Error('unsupported CID codec');
  return { version: 1, codec: codecCode === CODEC_RAW ? 'raw' : 'dag-pb', codecCode, digest: bytes.slice(4) };
}

const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');

/** Raw-leaf CIDv1 (codec raw, sha2-256, base32) of `data`. */
export async function computeCidV1(data) {
  return cidFromDigest(CODEC_RAW, await sha256(data));
}

/** Convert a SHA-256 hex digest (ChunkStore default form) to a raw-leaf CIDv1. */
export function cidV1FromSha256Hex(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/.test(hex)) throw new Error('expected a 64-char lowercase sha-256 hex digest');
  return cidFromDigest(CODEC_RAW, Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16)));
}

/** SHA-256 hex digest of a raw-leaf CIDv1, or null if the CID is not a raw leaf. */
export function sha256HexFromCid(cid) {
  const p = parseCid(cid);
  return p.codec === 'raw' ? toHex(p.digest) : null;
}

/**
 * Verify block bytes against either address form: SHA-256 hex or a CIDv1
 * (raw or dag-pb). Never throws; malformed addresses yield false.
 * @returns {Promise<boolean>}
 */
export async function verifyBlock(address, bytes) {
  try {
    const digest = await sha256(bytes);
    if (typeof address === 'string' && /^[0-9a-f]{64}$/.test(address)) return toHex(digest) === address;
    const p = parseCid(address);
    return toHex(p.digest) === toHex(digest);
  } catch {
    return false;
  }
}

// --- minimal protobuf / dag-pb / UnixFS encoding ---------------------------

function varint(n) {
  const out = [];
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
  return out;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const lenDelimited = (tag, bytes) => [Uint8Array.from([tag, ...varint(bytes.length)]), bytes];

/** dag-pb PBNode: links first (field 2), then Data (field 1). */
function encodePBNode(links, data) {
  const parts = [];
  for (const l of links) {
    const name = encoder.encode(l.name);
    const hash = l.hash;
    const link = concat([
      ...lenDelimited(0x0a, hash),
      ...lenDelimited(0x12, name),
      Uint8Array.from([0x18, ...varint(l.tsize)]),
    ]);
    parts.push(...lenDelimited(0x12, link));
  }
  if (data) parts.push(...lenDelimited(0x0a, data));
  return concat(parts);
}

const unixfsDirData = () => Uint8Array.from([0x08, 1]);

function unixfsFileData(filesize, blocksizes) {
  const b = [0x08, 2, 0x18, ...varint(filesize)];
  for (const s of blocksizes) b.push(0x20, ...varint(s));
  return Uint8Array.from(b);
}

function cidBytes(cid) {
  const p = parseCid(cid);
  return concat([Uint8Array.from([1, p.codecCode, MH_SHA256, 32]), p.digest]);
}

async function putBlock(blocks, codec, bytes) {
  const cid = cidFromDigest(codec, await sha256(bytes));
  blocks.set(cid, bytes);
  return cid;
}

/**
 * Build a UnixFS file DAG (raw leaves, balanced layout).
 * @param {Uint8Array} bytes
 * @param {{chunkSize?: number, maxLinks?: number, blocks?: Map<string, Uint8Array>}} [opts]
 * @returns {Promise<{cid: string, size: number, blocks: Map<string, Uint8Array>}>}
 *   `size` is the cumulative DAG size (dag-pb Tsize).
 */
export async function buildUnixfsFile(bytes, opts = {}) {
  const chunkSize = opts.chunkSize ?? CIDV1_DEFAULTS.chunkSize;
  const maxLinks = opts.maxLinks ?? CIDV1_DEFAULTS.maxLinks;
  const blocks = opts.blocks ?? new Map();
  // level entries: { cid, tsize, filesize }
  let level = [];
  if (bytes.length === 0) {
    level.push({ cid: await putBlock(blocks, CODEC_RAW, bytes), tsize: 0, filesize: 0 });
  } else {
    for (let off = 0; off < bytes.length; off += chunkSize) {
      const chunk = bytes.subarray(off, Math.min(off + chunkSize, bytes.length));
      level.push({ cid: await putBlock(blocks, CODEC_RAW, chunk), tsize: chunk.length, filesize: chunk.length });
    }
  }
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += maxLinks) {
      const group = level.slice(i, i + maxLinks);
      if (group.length === 1) { next.push(group[0]); continue; }
      const filesize = group.reduce((s, g) => s + g.filesize, 0);
      const node = encodePBNode(
        group.map((g) => ({ name: '', hash: cidBytes(g.cid), tsize: g.tsize })),
        unixfsFileData(filesize, group.map((g) => g.filesize)),
      );
      const tsize = node.length + group.reduce((s, g) => s + g.tsize, 0);
      next.push({ cid: await putBlock(blocks, CODEC_DAG_PB, node), tsize, filesize });
    }
    level = next;
  }
  return { cid: level[0].cid, size: level[0].tsize, blocks };
}

function normalisePath(p) {
  const segs = String(p).split('/').filter((s) => s !== '');
  if (segs.length === 0 || segs.some((s) => s === '.' || s === '..')) throw new Error(`invalid path: ${JSON.stringify(p)}`);
  return segs;
}

/**
 * Build a UnixFS directory DAG from a path -> bytes map.
 * @param {Map<string, Uint8Array>|Record<string, Uint8Array>} files
 * @param {{chunkSize?: number, maxLinks?: number}} [opts]
 * @returns {Promise<{cid: string, size: number, blocks: Map<string, Uint8Array>, files: Map<string, string>}>}
 *   `cid` is the root directory CID; `blocks` maps every block CID to its bytes
 *   (files, interior nodes, directories); `files` maps each (normalised) path to its file CID.
 */
export async function buildUnixfsDirectory(files, opts = {}) {
  const entries = files instanceof Map ? [...files] : Object.entries(files);
  if (entries.length === 0) throw new Error('cannot build an empty directory tree');
  const root = new Map();
  const paths = [];
  for (const [path, data] of entries) {
    const segs = normalisePath(path);
    paths.push([segs.join('/'), data]);
    let dir = root;
    for (let i = 0; i < segs.length - 1; i++) {
      let next = dir.get(segs[i]);
      if (next === undefined) { next = new Map(); dir.set(segs[i], next); }
      if (!(next instanceof Map)) throw new Error(`path conflict at ${segs.slice(0, i + 1).join('/')}`);
      dir = next;
    }
    const leaf = segs[segs.length - 1];
    if (dir.has(leaf)) throw new Error(`path conflict at ${segs.join('/')}`);
    dir.set(leaf, { data, path: segs.join('/') });
  }
  const blocks = new Map();
  const fileCids = new Map();

  async function build(dir) {
    const links = [];
    const names = [...dir.keys()].sort((a, b) => {
      const x = encoder.encode(a), y = encoder.encode(b);
      for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
      return x.length - y.length;
    });
    for (const name of names) {
      const child = dir.get(name);
      let r;
      if (child instanceof Map) {
        r = await build(child);
      } else {
        r = await buildUnixfsFile(child.data, { ...opts, blocks });
        fileCids.set(child.path, r.cid);
      }
      links.push({ name, hash: cidBytes(r.cid), tsize: r.size });
    }
    const node = encodePBNode(links, unixfsDirData());
    if (node.length > MAX_DIR_NODE_BYTES) throw new Error('directory too large: HAMT sharding is not supported');
    const cid = await putBlock(blocks, CODEC_DAG_PB, node);
    return { cid, size: node.length + links.reduce((s, l) => s + l.tsize, 0) };
  }

  const r = await build(root);
  return { cid: r.cid, size: r.size, blocks, files: fileCids };
}
