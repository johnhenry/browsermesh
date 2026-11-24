/**
 * The transport package serves wsh's object layer to a stock wsh client (`WshServices`) and cannot depend on this
 * package, so it keeps its own copy of the operation-to-action table. This test is where both can be imported:
 * the two must agree for every kind, and a kind neither names must be refused by both.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { actionFor } from '../src/actions.mjs'
import { wshObjectActionFor } from '@johnhenry/browsermesh-transport'

const KINDS = ['get', 'describe', 'snapshot', 'call', 'construct', 'set', 'on']

test('the wsh services and the mesh adapter map every operation to the same registry action', () => {
  for (const kind of KINDS) assert.equal(wshObjectActionFor({ kind }), actionFor({ kind }), kind)
  assert.equal(wshObjectActionFor({ kind: 'on' }), 'on', 'a subscription needs on')
})

test('a kind neither table names is refused by both, including inherited property names', () => {
  for (const kind of ['', 'toString', 'constructor', '__proto__', 'watch', undefined, 5]) {
    assert.equal(wshObjectActionFor({ kind }), null, String(kind))
    assert.equal(actionFor({ kind }), null, String(kind))
  }
  assert.equal(wshObjectActionFor(undefined), null)
  assert.equal(actionFor(undefined), null)
})
