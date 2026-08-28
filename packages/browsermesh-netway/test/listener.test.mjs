import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Listener } from '../src/listener.mjs';

describe('Listener', () => {
  it('enqueue→accept immediate', async () => {
    const listener = new Listener({ localPort: 8080 });
    const mockSocket = { id: 'socket1' };
    listener._enqueue(mockSocket);
    const result = await listener.accept();
    assert.equal(result, mockSocket);
    listener.close();
  });

  it('accept blocks until enqueue', async () => {
    const listener = new Listener({ localPort: 8080 });
    let resolved = false;
    const acceptPromise = listener.accept().then(s => { resolved = true; return s; });
    // Not yet resolved
    await new Promise(r => setTimeout(r, 10));
    assert.equal(resolved, false);

    const mockSocket = { id: 'socket2' };
    listener._enqueue(mockSocket);
    const result = await acceptPromise;
    assert.equal(resolved, true);
    assert.equal(result, mockSocket);
    listener.close();
  });

  it('close resolves pending accept with null', async () => {
    const listener = new Listener({ localPort: 8080 });
    const acceptPromise = listener.accept();
    listener.close();
    const result = await acceptPromise;
    assert.equal(result, null);
  });

  it('accept after close returns null', async () => {
    const listener = new Listener({ localPort: 8080 });
    listener.close();
    const result = await listener.accept();
    assert.equal(result, null);
  });

  it('multiple accept calls', async () => {
    const listener = new Listener({ localPort: 8080 });
    const s1 = { id: 1 };
    const s2 = { id: 2 };
    listener._enqueue(s1);
    listener._enqueue(s2);
    const r1 = await listener.accept();
    const r2 = await listener.accept();
    assert.equal(r1, s1);
    assert.equal(r2, s2);
    listener.close();
  });

  it('localPort is accessible', () => {
    const listener = new Listener({ localPort: 9999 });
    assert.equal(listener.localPort, 9999);
    listener.close();
  });

  it('closed property', () => {
    const listener = new Listener({ localPort: 8080 });
    assert.equal(listener.closed, false);
    listener.close();
    assert.equal(listener.closed, true);
  });
});
