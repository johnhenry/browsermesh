/**
 * node-runtime-entry.mjs -- the code that runs INSIDE a `worker_threads`
 * worker or a Node child process started by `node-runtimes.mjs`. It loads
 * the hosted module (a path the host chose, never one the requester sent)
 * and answers requests from the host over the channel it was started with.
 *
 * Not part of the package's public surface: `node-runtimes.mjs` points
 * `Worker`/`fork` at this file. See `pod-runtime.mjs` for the module
 * contract (`start(ctx)`, `handle(payload, ctx)`).
 *
 * Messages to the host: `{type: 'ready'}`, `{type: 'start-error', message}`,
 * `{type: 'log', line}`, `{type: 'reply', id, ok, reply|message}`.
 * Messages from the host: `{type: 'request', id, payload}`.
 */

import { parentPort, workerData } from 'node:worker_threads'

const inWorker = parentPort !== null
const config = inWorker ? workerData : JSON.parse(process.argv[2])
const post = (message) => (inWorker ? parentPort.postMessage(message) : process.send(message))
const listen = (fn) => (inWorker ? parentPort.on('message', fn) : process.on('message', fn))

const ctx = {
  name: config.name,
  env: config.env,
  input: config.input,
  log: (line) => post({ type: 'log', line: String(line) }),
}

let hosted
try {
  hosted = await import(config.moduleUrl)
  if (typeof hosted.handle !== 'function') throw new Error('the module must export handle(payload, ctx)')
  if (typeof hosted.start === 'function') await hosted.start(ctx)
} catch (err) {
  post({ type: 'start-error', message: String(err?.message ?? err) })
  // Give the message a chance to flush before this context ends.
  setTimeout(() => process.exit(1), 50)
  await new Promise(() => {})
}

listen(async (message) => {
  if (message?.type !== 'request') return
  try {
    const reply = await hosted.handle(message.payload, ctx)
    post({ type: 'reply', id: message.id, ok: true, reply: reply ?? null })
  } catch (err) {
    post({ type: 'reply', id: message.id, ok: false, message: String(err?.message ?? err) })
  }
})
post({ type: 'ready' })
