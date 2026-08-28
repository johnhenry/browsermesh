import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Stdio } from '../src/stdio.mjs';
import { createPipe, devNull } from '../src/byte-stream.mjs';

describe('Stdio', () => {
  it('defaults to devNull', async () => {
    const stdio = new Stdio();
    assert.equal(await stdio.stdin.read(), null);
    await stdio.stdout.write(new Uint8Array([1])); // no throw
    await stdio.stderr.write(new Uint8Array([1])); // no throw
  });

  it('print writes text to stdout', async () => {
    const [reader, writer] = createPipe();
    const stdio = new Stdio({ stdout: writer });
    await stdio.print('hello');
    const chunk = await reader.read();
    assert.equal(new TextDecoder().decode(chunk), 'hello');
    await reader.close();
    await writer.close();
  });

  it('println writes text with newline', async () => {
    const [reader, writer] = createPipe();
    const stdio = new Stdio({ stdout: writer });
    await stdio.println('world');
    const chunk = await reader.read();
    assert.equal(new TextDecoder().decode(chunk), 'world\n');
    await reader.close();
    await writer.close();
  });

  it('custom stdin', async () => {
    const [reader, writer] = createPipe();
    await writer.write(new TextEncoder().encode('input'));
    const stdio = new Stdio({ stdin: reader });
    const chunk = await stdio.stdin.read();
    assert.equal(new TextDecoder().decode(chunk), 'input');
    await reader.close();
    await writer.close();
  });

  it('accessors return streams', () => {
    const stdio = new Stdio();
    assert.ok(stdio.stdin);
    assert.ok(stdio.stdout);
    assert.ok(stdio.stderr);
  });
});
