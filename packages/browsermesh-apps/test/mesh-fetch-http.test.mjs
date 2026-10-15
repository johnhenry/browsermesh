import { test } from 'node:test'
import assert from 'node:assert/strict'
import { network } from './helpers/rpc-network.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { createMeshRpcService } from '../src/mesh-rpc.mjs'
import { createBrowserMeshFetch } from '../src/mesh-fetch.mjs'

async function fixture(handler, run, options) {
  const [alice,bob]=await network()
  const a=attachService(alice,undefined,createMeshRpcService())
  const b=attachService(bob,undefined,createMeshRpcService({onRequest:handler}))
  try {await run(createBrowserMeshFetch(a.api,options),'mesh://'+bob.podId)}
  finally {a.teardown();b.teardown()}
}

test('factory and byte response work when Node process is absent', async () => {
  const saved=globalThis.process
  try {
    globalThis.process=undefined
    const fetch=createBrowserMeshFetch({request:async()=>({body:new Uint8Array([0,255])})})
    assert.deepEqual(new Uint8Array(await (await fetch('mesh://peer/data')).arrayBuffer()),new Uint8Array([0,255]))
  } finally {globalThis.process=saved}
})

test('HTTP mode preserves text and arbitrary binary bytes over JSON RPC', async () => {
  await fixture(async ({body})=>({body,headers:{'content-type':'application/octet-stream'}}),async (fetch,base)=>{
    for (const body of ['42','{"not":"parsed"}',new Uint8Array([0,255,254,65])]) {
      const response=await fetch(base+'/file',{method:'PUT',body})
      const expected=typeof body==='string'?new TextEncoder().encode(body):body
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()),expected)
    }
  },{bodyMode:'http'})
})

test('Request input uses exact bytes and preserves path and query', async () => {
  let seen
  await fixture(async req=>{seen=req;return {body:req.body}},async (fetch,base)=>{
    const request=new Request(base+'/files?download=1#ignored',{method:'POST',headers:{'x-test':'original'},body:new Uint8Array([255,0])})
    const response=await fetch(request,{headers:{'x-test':'override'}})
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()),new Uint8Array([255,0]))
    assert.equal(seen.path,'/files?download=1')
    assert.equal(seen.headers['x-test'],'override')
  })
})

test('HTTP mode constructs multipart content type and bytes with native Request', async () => {
  let seen
  await fixture(async req=>{seen=req;return {body:'ok'}},async (fetch,base)=>{
    const form=new FormData();form.append('text','hello');form.append('file',new Blob([new Uint8Array([0,255])]),'file.bin')
    await fetch(base+'/submit',{method:'POST',body:form})
    assert.match(seen.headers['content-type'],/^multipart\/form-data; boundary=/)
    const reconstructed=new Request('https://test.invalid/',{method:'POST',headers:seen.headers,body:seen.body})
    const parsed=await reconstructed.formData()
    assert.equal(parsed.get('text'),'hello')
    assert.deepEqual(new Uint8Array(await parsed.get('file').arrayBuffer()),new Uint8Array([0,255]))
  },{bodyMode:'http'})
})

test('HEAD and bodyless response statuses always have a null body', async () => {
  for (const status of [204,205,304]) {
    const fetch=createBrowserMeshFetch({request:async()=>({status,body:null})})
    const response=await fetch('mesh://peer/file')
    assert.equal(response.status,status);assert.equal(response.body,null)
  }
  const fetch=createBrowserMeshFetch({request:async()=>({body:'ignored'})})
  assert.equal((await fetch('mesh://peer/file',{method:'HEAD'})).body,null)
})

test('an aborted fetch never dispatches and active fetch cancellation reaches its handler', async () => {
  const ac=new AbortController();ac.abort()
  const fetch=createBrowserMeshFetch({request:async()=>{assert.fail('must not send')}})
  await assert.rejects(fetch('mesh://peer/file',{signal:ac.signal}),{name:'AbortError'})
  let started,stopped
  const ready=new Promise(r=>{started=r}),done=new Promise(r=>{stopped=r})
  await fixture(async ({signal})=>{
    started();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));stopped();return {body:'late'}
  },async (fetch,base)=>{
    const active=new AbortController(),pending=fetch(base+'/work',{signal:active.signal})
    const rejected=assert.rejects(pending,{name:'AbortError'})
    await ready;active.abort();await rejected;await done
  },{bodyMode:'http'})
})

test('oversized streamed upload cancels the producer without sending RPC', async () => {
  let cancelled=false,sends=0
  const body=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(8))},cancel(){cancelled=true}})
  const fetch=createBrowserMeshFetch({request:async()=>{sends++}},{bodyMode:'http',maxBodyBytes:4})
  await assert.rejects(fetch('mesh://peer/file',{method:'PUT',body}),/maxBodyBytes/)
  assert.equal(cancelled,true);assert.equal(sends,0)
})

test('a producer with a hanging cancellation hook cannot delay local rejection', async () => {
  const body=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(8))},cancel(){return new Promise(()=>{})}})
  const fetch=createBrowserMeshFetch({request:async()=>assert.fail('must not send')},{bodyMode:'http',maxBodyBytes:4})
  let timer
  try {
    await assert.rejects(Promise.race([
      fetch('mesh://peer/file',{method:'PUT',body}),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('cancellation blocked rejection')),500)}),
    ]),/maxBodyBytes/)
  } finally {clearTimeout(timer)}
})
