// Regenerates cidv1-golden.json using the reference IPFS implementation.
//   mkdir /tmp/gold && cd /tmp/gold && npm init -y && \
//     npm i ipfs-unixfs-importer@17 blockstore-core@7
//   NODE_PATH-free: copy/run this file from that dir, e.g.
//   cp test/fixtures/*.mjs /tmp/gold/ && (cd /tmp/gold && node gen-cidv1-golden.mjs > cidv1-golden.json)
// Importer options (these are also the defaults): cidVersion 1, rawLeaves
// true, fixed-size 256 KiB chunker, balanced layout with maxChildrenPerNode
// 174, sha2-256. Directories: wrapWithDirectory.
import { importer } from 'ipfs-unixfs-importer';
import { fixedSize } from 'ipfs-unixfs-importer/chunker';
import { balanced } from 'ipfs-unixfs-importer/layout';
import { MemoryBlockstore } from 'blockstore-core/memory';
import { FIXTURES } from './cidv1-trees.mjs';

const out = {};
for (const [name, fx] of Object.entries(FIXTURES)) {
  const blockstore = new MemoryBlockstore();
  const opts = {
    cidVersion: 1, rawLeaves: true,
    chunker: fixedSize({ chunkSize: 262144 }),
    layout: balanced({ maxChildrenPerNode: 174 }),
  };
  let entries = [];
  if (fx.kind === 'file') {
    entries = [{ path: 'f', content: fx.bytes }];
  } else {
    entries = Object.entries(fx.files).map(([path, content]) => ({ path, content }));
    opts.wrapWithDirectory = true;
  }
  const results = [];
  for await (const r of importer(entries, blockstore, opts)) results.push(r);
  const root = fx.kind === 'file' ? results.find((r) => r.path === 'f') : results[results.length - 1];
  let blocks = 0;
  for await (const _ of blockstore.getAll()) blocks++;
  out[name] = { root: root.cid.toString(), blocks };
}
console.log(JSON.stringify(out, null, 2));
