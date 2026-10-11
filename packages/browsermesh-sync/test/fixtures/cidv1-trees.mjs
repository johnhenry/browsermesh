// Deterministic fixture trees for the CIDv1 / UnixFS golden tests.
// Content is generated from a tiny LCG so it is reproducible without
// checking in binary files. Keep in sync with cidv1-golden.json (see
// gen-cidv1-golden.mjs for how the goldens are produced).
const enc = new TextEncoder();

export function pseudoBytes(length, seed = 1) {
  const out = new Uint8Array(length);
  let s = seed >>> 0;
  for (let i = 0; i < length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

export const CHUNK = 256 * 1024;

/** name -> { kind: 'file'|'dir', files: Map path->bytes } */
export const FIXTURES = {
  'empty-file': { kind: 'file', bytes: new Uint8Array(0) },
  'small-file': { kind: 'file', bytes: enc.encode('hello world\n') },
  'large-file-2-chunks': { kind: 'file', bytes: pseudoBytes(CHUNK + 1000, 7) },
  'large-file-exact-chunk': { kind: 'file', bytes: pseudoBytes(CHUNK, 9) },
  // > 174 leaves forces a second level of the balanced layout
  'huge-file-175-chunks': { kind: 'file', bytes: pseudoBytes(CHUNK * 175 + 5, 3) },
  'small-dir': {
    kind: 'dir',
    files: {
      'index.html': enc.encode('<!doctype html><title>hi</title>\n'),
      'style.css': enc.encode('body{margin:0}\n'),
    },
  },
  'nested-dirs': {
    kind: 'dir',
    files: {
      'index.html': enc.encode('<h1>root</h1>\n'),
      'css/site.css': enc.encode('h1{color:red}\n'),
      'js/app/main.js': enc.encode('console.log(1)\n'),
      'js/app/util.js': enc.encode('export const x = 1\n'),
      'img/empty.bin': new Uint8Array(0),
      'z-last.txt': enc.encode('zzz\n'),
    },
  },
  'dir-with-large-file': {
    kind: 'dir',
    files: {
      'big.bin': pseudoBytes(CHUNK * 2 + 123, 5),
      'readme.txt': enc.encode('readme\n'),
    },
  },
};
