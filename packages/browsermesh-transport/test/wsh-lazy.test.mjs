// Run with: node --import ./test/_setup-globals.mjs --test test/wsh-lazy.test.mjs
//
// `@johnhenry/wsh` is an optional peer dependency: nothing in this package's
// main entry may load it (or its Node-only pipe relay) until a wsh link is
// actually used.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));

describe('@johnhenry/wsh is optional and lazy', () => {
  it('no module in src has a static import of @johnhenry/wsh', () => {
    for (const file of readdirSync(srcDir).filter((f) => f.endsWith('.mjs'))) {
      const text = readFileSync(join(srcDir, file), 'utf8');
      const staticImports = text.split('\n').filter((l) => /^\s*(import|export)\b[^(]*\bfrom\s+['"]@johnhenry\/wsh/.test(l) || /^\s*import\s+['"]@johnhenry\/wsh/.test(l));
      assert.deepEqual(staticImports, [], `${file} imports wsh statically`);
    }
  });

  it('the main entry does not export the in-process relay (it reaches wsh\'s Node-only pipe relay)', () => {
    const index = readFileSync(join(srcDir, 'index.mjs'), 'utf8');
    assert.equal(/^export .*wsh-in-process/m.test(index), false);
    assert.equal(pkg.exports['./wsh-in-process'], './src/wsh-in-process.mjs');
  });

  it('wsh is an optional peer dependency, and a dev dependency for the tests', () => {
    assert.ok(pkg.peerDependencies['@johnhenry/wsh']);
    assert.equal(pkg.peerDependenciesMeta['@johnhenry/wsh'].optional, true);
    assert.ok(pkg.devDependencies['@johnhenry/wsh']);
  });

  it('every wsh import() in the link code has a literal specifier (so a bundler can split it and a browser can resolve it)', () => {
    const text = readFileSync(join(srcDir, 'wsh-links.mjs'), 'utf8');
    const dynamic = [...text.matchAll(/\bimport\(\s*([^)\s][^)]*)\)/g)].map((m) => m[1].trim());
    assert.ok(dynamic.length >= 2);
    for (const spec of dynamic) assert.match(spec, /^'@johnhenry\/wsh(\/memory)?'$/, `non-literal import(${spec})`);
  });

  it('importing the main entry does not load wsh', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const script = `
      const seen = [];
      const { register } = await import('node:module');
      await import('${new URL('../src/index.mjs', import.meta.url).href}');
      const loaded = process.moduleLoadList ? process.moduleLoadList.filter((m) => /wsh/i.test(m)) : [];
      console.log(JSON.stringify(loaded));
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', fileURLToPath(new URL('./_setup-globals.mjs', import.meta.url)), '--input-type=module', '-e', script]);
    assert.equal(stdout.trim(), '[]');
  });
});
