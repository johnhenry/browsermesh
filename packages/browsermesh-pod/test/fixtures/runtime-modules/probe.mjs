// A hosted module for the runtime tests. `handle()` performs the probe the
// test asks for and reports what happened, so a test can say what a pod
// running in a given runtime can and cannot reach.
import fs from 'node:fs'
import net from 'node:net'
import cp from 'node:child_process'
import { Worker } from 'node:worker_threads'

function outcome(fn) {
  try {
    return { ok: true, value: fn() }
  } catch (err) {
    return { ok: false, code: err.code ?? err.name }
  }
}

export async function start(ctx) {
  ctx.log(`started ${ctx.name}`)
}

export async function handle(message, ctx) {
  const { probe, arg } = message.payload ?? {}
  switch (probe) {
    case 'echo':
      return { echoed: message.payload }
    case 'env':
      return { ctxEnv: ctx.env, processEnvKeys: Object.keys(process.env).sort() }
    case 'fs-read':
      return outcome(() => fs.readFileSync(arg, 'utf8'))
    case 'fs-write':
      return outcome(() => { fs.writeFileSync(arg, 'written by the pod'); return 'wrote' })
    case 'spawn':
      return outcome(() => cp.execFileSync(process.execPath, ['-p', '1 + 1'], { encoding: 'utf8' }).trim())
    case 'worker':
      return outcome(() => { new Worker('1', { eval: true }).terminate(); return 'started' })
    case 'net':
      return new Promise((resolve) => {
        let socket
        try {
          socket = net.connect(arg, '127.0.0.1')
        } catch (err) {
          resolve({ ok: false, code: err.code ?? err.name })
          return
        }
        socket.on('connect', () => { socket.destroy(); resolve({ ok: true, value: 'connected' }) })
        socket.on('error', (err) => resolve({ ok: false, code: err.code }))
      })
    case 'crash':
      setTimeout(() => { throw new Error('boom') }, 0)
      return 'scheduled'
    case 'exit':
      setTimeout(() => process.exit(3), 0)
      return 'scheduled'
    case 'alloc': {
      const hold = []
      for (;;) hold.push(new Array(1_000_000).fill(hold.length))
    }
    case 'hang':
      return new Promise(() => {})
    default:
      throw new Error(`unknown probe '${probe}'`)
  }
}
