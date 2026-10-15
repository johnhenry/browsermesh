import { test } from 'node:test'
import assert from 'node:assert/strict'
import { network } from './helpers/rpc-network.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { createMeshRpcService } from '../src/mesh-rpc.mjs'

const deferred = () => { let resolve; const promise = new Promise(r => {resolve=r}); return {promise, resolve} }
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test('RPC ignores a matching response ID from another authenticated transport peer', async () => {
  const [alice, bob, eve] = await network(), received = deferred(), reply = deferred()
  let requestId
  bob.onIncomingData((_from, text) => {requestId=JSON.parse(text).requestId})
  const a = attachService(alice, undefined, createMeshRpcService())
  const b = attachService(bob, undefined, createMeshRpcService({onRequest: async () => {received.resolve();await reply.promise;return {body:'genuine'}}}))
  try {
    const result = a.api.request(bob.podId, {path:'/protected'})
    await received.promise
    await eve.sendTo(alice.podId, {type:'mesh-rpc',kind:'rpc-response',requestId,status:200,body:'forged'})
    await tick()
    reply.resolve()
    assert.equal((await result).body,'genuine')
  } finally {a.teardown();b.teardown()}
})

test('binary request and response survive JSON-only transport without changing JSON object bodies', async () => {
  const [alice,bob] = await network()
  const a=attachService(alice,undefined,createMeshRpcService())
  const b=attachService(bob,undefined,createMeshRpcService({onRequest:async ({body})=>({body})}))
  try {
    for (const bytes of [new Uint8Array(),new Uint8Array([0,255,254,65]),new Uint8Array([1,2,3]).subarray(1)]) {
      const response=await a.api.request(bob.podId,{method:'PUT',body:bytes})
      assert.ok(response.body instanceof Uint8Array)
      assert.deepEqual(response.body,bytes)
    }
    const object={bodyEncoding:'base64',body:'AA==',nested:[null,42]}
    assert.deepEqual((await a.api.request(bob.podId,{body:object})).body,object)
  } finally {a.teardown();b.teardown()}
})

test('only the caller can cancel its inbound request; late results do not revive it', async () => {
  const [alice,bob,eve]=await network(),started=deferred(),finished=deferred()
  let requestId,signal
  bob.onIncomingData((_from,text)=>{const msg=JSON.parse(text);if(msg.kind==='rpc-request')requestId=msg.requestId})
  const a=attachService(alice,undefined,createMeshRpcService())
  const b=attachService(bob,undefined,createMeshRpcService({onRequest:async request=>{signal=request.signal;started.resolve();await finished.promise;return {body:'late'}}}))
  const ac=new AbortController()
  try {
    const pending=a.api.request(bob.podId,{}, {signal:ac.signal})
    const rejected=assert.rejects(pending,{name:'AbortError'})
    await started.promise
    await eve.sendTo(bob.podId,{type:'mesh-rpc',kind:'rpc-cancel',requestId})
    await tick();assert.equal(signal.aborted,false)
    ac.abort();await rejected;await tick();assert.equal(signal.aborted,true)
    finished.resolve();await tick()
    assert.equal((await a.api.request(bob.podId,{path:'/next'})).body,'late')
  } finally {finished.resolve();a.teardown();b.teardown()}
})

test('an already aborted request is never sent', async () => {
  let sends=0
  const handle=createMeshRpcService().attach({podId:'caller'},{onIncomingData:()=>()=>{},sendTo:async()=>{sends++},emit(){}})
  const ac=new AbortController();ac.abort()
  await assert.rejects(handle.api.request('target',{}, {signal:ac.signal}),{name:'AbortError'})
  assert.equal(sends,0)
  handle.teardown()
})

test('timeout cancels the remote handler and a send failure rejects without orphan promises', async () => {
  const [alice,bob]=await network(),started=deferred(),stopped=deferred()
  const a=attachService(alice,undefined,createMeshRpcService())
  const b=attachService(bob,undefined,createMeshRpcService({onRequest:async ({signal})=>{started.resolve();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));stopped.resolve();return {body:'ignored'}}}))
  try {
    const pending=a.api.request(bob.podId,{}, {timeoutMs:30})
    const rejected=assert.rejects(pending,/timed out/)
    await started.promise;await rejected;await stopped.promise
    await assert.rejects(a.api.request('missing'),/unreachable/)
  } finally {a.teardown();b.teardown()}
})

test('body and outgoing concurrency limits fail before sending more work', async () => {
  const [alice,bob]=await network(),started=deferred(),finish=deferred()
  const a=attachService(alice,undefined,createMeshRpcService({maxBodyBytes:4,maxInflight:1}))
  const b=attachService(bob,undefined,createMeshRpcService({onRequest:async()=>{started.resolve();await finish.promise;return {body:1}}}))
  try {
    await assert.rejects(a.api.request(bob.podId,{body:new Uint8Array(5)}),/maxBodyBytes/)
    const pending=a.api.request(bob.podId,{body:0});await started.promise
    await assert.rejects(a.api.request(bob.podId,{body:0}),/too many/)
    finish.resolve();assert.equal((await pending).body,1)
  } finally {finish.resolve();a.teardown();b.teardown()}
})

test('receiver limits reject oversized bodies and refuse excess concurrent handlers', async () => {
  const [alice,bob]=await network(),started=deferred(),finish=deferred()
  let calls=0
  const a=attachService(alice,undefined,createMeshRpcService())
  const b=attachService(bob,undefined,createMeshRpcService({maxBodyBytes:4,maxIncoming:1,onRequest:async()=>{calls++;started.resolve();await finish.promise;return {body:1}}}))
  try {
    assert.equal((await a.api.request(bob.podId,{body:new Uint8Array(5)})).status,400)
    const pending=a.api.request(bob.podId,{body:0});await started.promise
    assert.equal((await a.api.request(bob.podId,{body:0})).status,429)
    assert.equal(calls,1)
    finish.resolve();await pending
  } finally {finish.resolve();a.teardown();b.teardown()}
})

test('teardown aborts handlers, rejects pending and future calls, and is idempotent', async () => {
  const [alice,bob]=await network(),started=deferred(),finish=deferred()
  let signal
  const a=attachService(alice,undefined,createMeshRpcService())
  const b=attachService(bob,undefined,createMeshRpcService({onRequest:async request=>{signal=request.signal;started.resolve();await finish.promise;return {body:1}}}))
  const pending=a.api.request(bob.podId)
  const rejected=assert.rejects(pending,/torn down/)
  await started.promise;a.teardown();b.teardown();a.teardown();b.teardown()
  assert.equal(signal.aborted,true)
  await rejected;await assert.rejects(a.api.request(bob.podId),/torn down/)
  finish.resolve();await tick()
})
