// A hosted module for the isolate runtime tests: no imports, because the
// isolate lane gives a module nothing to import. `handle()` performs the probe
// the test asks for and reports what it saw.

let ctxSeen = null

export async function start(ctx) {
  ctxSeen = ctx
  ctx.log(`started ${ctx.name}`)
}

// Names a pod must not find in its global scope.
const FORBIDDEN = [
  'require', 'process', 'Buffer', 'module', 'exports', '__dirname', '__filename', 'global',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask',
  'structuredClone', 'TextEncoder', 'URL', 'WebAssembly', 'performance', 'navigator', 'window', 'self',
  'ivm', '$0', '__bm_log',
]

/** Everything reachable by walking own properties and prototypes from the given roots. */
function reachable(roots, limit = 5000) {
  const seen = new Set()
  const queue = [...roots]
  while (queue.length && seen.size < limit) {
    const value = queue.pop()
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) continue
    if (seen.has(value)) continue
    seen.add(value)
    let names = []
    try { names = Reflect.ownKeys(value) } catch { /* proxies */ }
    for (const key of names) {
      try {
        const desc = Object.getOwnPropertyDescriptor(value, key)
        if (desc) { queue.push(desc.value, desc.get, desc.set) }
      } catch { /* ignore */ }
    }
    try { queue.push(Object.getPrototypeOf(value)) } catch { /* ignore */ }
  }
  return seen
}

export async function handle(message, ctx) {
  const { probe, arg } = message.payload ?? {}
  switch (probe) {
    case 'echo':
      return { echoed: message.payload }
    case 'ctx':
      return { name: ctx.name, env: ctx.env, input: ctx.input, keys: Object.keys(ctx).sort(), frozen: Object.isFrozen(ctx) }
    case 'log':
      ctx.log(arg)
      return 'logged'
    case 'forbidden-globals':
      return FORBIDDEN.filter((name) => typeof globalThis[name] !== 'undefined')
    case 'dynamic-import':
      try { await import('node:fs'); return 'imported' } catch (err) { return `refused: ${String(err?.message).slice(0, 40)}` }
    // -- escape attempts: each answers what it reached --
    case 'function-constructor': {
      const fromLog = ctx.log.constructor.constructor('return typeof process + "/" + typeof require + "/" + typeof globalThis.fetch')()
      const fromObject = ({}).constructor.constructor('return typeof process')()
      const fromEnv = ctx.env.constructor.constructor('return typeof process')()
      return { fromLog, fromObject, fromEnv }
    }
    case 'prototype-walk': {
      // Every function and object reachable from everything the pod was handed.
      const found = reachable([ctx, ctx.log, ctx.env, ctx.input, message, globalThis])
      const hostish = []
      for (const value of found) {
        const text = (() => { try { return Object.prototype.toString.call(value) } catch { return '' } })()
        if (/process|Reference|ExternalCopy|Isolate|Context|Callback/.test(text)) hostish.push(text)
        const ctor = (() => { try { return value?.constructor?.name } catch { return '' } })()
        if (/^(Reference|ExternalCopy|Isolate|Context|Module|Script|Callback)$/.test(ctor)) hostish.push(`ctor:${ctor}`)
      }
      // Any function found, asked for process or require through its Function constructor.
      let leaks = 0
      for (const value of found) {
        if (typeof value !== 'function') continue
        try {
          const probeResult = Function.prototype.constructor.call(value.constructor, 'return typeof process + typeof require')()
          if (probeResult !== 'undefinedundefined') leaks += 1
        } catch { /* a constructor that refuses is fine */ }
      }
      return { reached: found.size > 50, hostish, leaks }
    }
    case 'thenable-log': {
      // A thenable handed to a host callback: the callback gets a string, never the object.
      let thenCalled = false
      ctx.log({ then(resolve) { thenCalled = true; resolve(ctx) }, toString() { return 'thenable' } })
      return { thenCalled }
    }
    case 'log-result': {
      // What the host callback returns to the pod.
      const result = ctx.log('x')
      return { type: typeof result, isThenable: typeof result?.then === 'function' }
    }
    case 'log-reenter': {
      // The host's log handler is told to call back into this pod; the pod does not wait for it.
      ctx.log('reenter')
      return 'logged'
    }
    case 'tamper-reply':
      // Break the pod's own JSON; the host must treat whatever comes back as untrusted.
      JSON.stringify = () => ({ not: 'a string' })
      return 'tampered'
    case 'huge-reply':
      return 'x'.repeat(arg ?? 2_000_000)
    case 'unserialisable-reply':
      return { value: 1n }
    case 'throw-weird':
      throw { get message() { throw new Error('hostile getter') } }
    case 'throw-error':
      throw new Error(`unknown probe '${arg}'`)
    case 'wasm-memory':
      return typeof WebAssembly === 'undefined' ? 'no WebAssembly' : new WebAssembly.Memory({ initial: 3000 }).buffer.byteLength
    case 'alloc': {
      const hold = []
      for (;;) hold.push(new Array(100_000).fill(hold.length))
    }
    case 'alloc-mib': {
      // Holds about `arg` MiB of heap, then answers.
      const hold = []
      for (let i = 0; i < arg; i += 1) hold.push(new Array(131_072).fill(i))
      return hold.length
    }
    case 'alloc-buffers': {
      const hold = []
      for (;;) hold.push(new ArrayBuffer(1 << 24))
    }
    case 'spin':
      for (;;) { /* a tight loop */ }
    case 'spin-microtasks':
      for (;;) await null
    case 'spin-after-await':
      await null
      for (;;) { /* a tight loop after the first await */ }
    case 'atomics-wait':
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
      return 'woke'
    case 'hang':
      return new Promise(() => {})
    case 'seen-ctx':
      return { same: ctxSeen === ctx }
    default:
      throw new Error(`unknown probe '${probe}'`)
  }
}
