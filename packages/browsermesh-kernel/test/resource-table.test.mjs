import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ResourceTable } from '../src/resource-table.mjs';

describe('ResourceTable', () => {
  it('allocate returns incrementing handles', () => {
    const table = new ResourceTable();
    const h1 = table.allocate('stream', 'val1', 'tenant_1');
    const h2 = table.allocate('port', 'val2', 'tenant_1');
    assert.match(h1, /^res_\d+$/);
    assert.match(h2, /^res_\d+$/);
    assert.notEqual(h1, h2);
  });

  it('get returns entry', () => {
    const table = new ResourceTable();
    const h = table.allocate('stream', { fd: 42 }, 'tenant_1');
    const entry = table.get(h);
    assert.equal(entry.type, 'stream');
    assert.deepEqual(entry.value, { fd: 42 });
    assert.equal(entry.owner, 'tenant_1');
  });

  it('get throws HandleNotFoundError for missing handle', () => {
    const table = new ResourceTable();
    assert.throws(() => table.get('res_999'), { name: 'HandleNotFoundError' });
  });

  it('getTyped returns value for matching type', () => {
    const table = new ResourceTable();
    const h = table.allocate('stream', 'myStream', 'tenant_1');
    assert.equal(table.getTyped(h, 'stream'), 'myStream');
  });

  it('getTyped throws HandleTypeMismatchError for wrong type', () => {
    const table = new ResourceTable();
    const h = table.allocate('stream', 'val', 'tenant_1');
    assert.throws(() => table.getTyped(h, 'port'), { name: 'HandleTypeMismatchError' });
  });

  it('transfer changes owner', () => {
    const table = new ResourceTable();
    const h = table.allocate('stream', 'val', 'tenant_1');
    table.transfer(h, 'tenant_2');
    assert.equal(table.get(h).owner, 'tenant_2');
  });

  it('transfer throws for missing handle', () => {
    const table = new ResourceTable();
    assert.throws(() => table.transfer('res_999', 'tenant_2'), { name: 'HandleNotFoundError' });
  });

  it('drop removes entry and returns value', () => {
    const table = new ResourceTable();
    const h = table.allocate('stream', 'val', 'tenant_1');
    assert.equal(table.size, 1);
    const val = table.drop(h);
    assert.equal(val, 'val');
    assert.equal(table.size, 0);
    assert.equal(table.has(h), false);
  });

  it('drop throws for missing handle', () => {
    const table = new ResourceTable();
    assert.throws(() => table.drop('res_999'), { name: 'HandleNotFoundError' });
  });

  it('has returns true/false', () => {
    const table = new ResourceTable();
    const h = table.allocate('stream', 'val', 'tenant_1');
    assert.equal(table.has(h), true);
    assert.equal(table.has('res_999'), false);
  });

  it('listByOwner', () => {
    const table = new ResourceTable();
    table.allocate('stream', 'a', 'tenant_1');
    table.allocate('port', 'b', 'tenant_2');
    table.allocate('stream', 'c', 'tenant_1');
    const owned = table.listByOwner('tenant_1');
    assert.equal(owned.length, 2);
  });

  it('listByType', () => {
    const table = new ResourceTable();
    table.allocate('stream', 'a', 'tenant_1');
    table.allocate('port', 'b', 'tenant_1');
    table.allocate('stream', 'c', 'tenant_2');
    assert.equal(table.listByType('stream').length, 2);
    assert.equal(table.listByType('port').length, 1);
  });

  it('clear removes all entries', () => {
    const table = new ResourceTable();
    table.allocate('stream', 'a', 'tenant_1');
    table.allocate('port', 'b', 'tenant_1');
    table.clear();
    assert.equal(table.size, 0);
  });

  it('throws TableFullError at max capacity', () => {
    const table = new ResourceTable({ maxSize: 2 });
    table.allocate('stream', 'a', 'tenant_1');
    table.allocate('stream', 'b', 'tenant_1');
    assert.throws(() => table.allocate('stream', 'c', 'tenant_1'), { name: 'TableFullError' });
  });
});
