import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMeshRequest } from '../src/index.mjs'

test('shared parser preserves identity case, query and path while removing fragments', () => {
  for (const url of ['mesh://AbC_123/file?x=1#fragment','https://AbC_123.mesh.local/file?x=1#fragment']) {
    assert.deepEqual(parseMeshRequest(url),{podId:'AbC_123',path:'/file?x=1'})
  }
  assert.deepEqual(parseMeshRequest('mesh://AbC?x=1'),{podId:'AbC',path:'/?x=1'})
  assert.deepEqual(parseMeshRequest('mesh://AbC#fragment'),{podId:'AbC',path:'/'})
  for (const url of ['mesh://','https://example.test/file','',null]) assert.equal(parseMeshRequest(url),null)
})
