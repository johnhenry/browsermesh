/**
 * fake-firecracker-server.mjs — minimal stand-in for a real Firecracker
 * API socket, used so the whole client surface can be exercised on
 * macOS/CI with no KVM and no real `firecracker` binary.
 *
 * Listens on a unix socket (like the real thing) and shapes its
 * responses the same way: `204 No Content` for successful mutations,
 * `200` + JSON for GETs, `400` + `{fault_message}` for anything the
 * fake considers invalid. It records every request it receives so tests
 * can assert on method/path/body.
 */

import http from 'node:http'
import { unlinkSync, existsSync } from 'node:fs'

export class FakeFirecrackerServer {
  #server
  #socketPath
  /** @type {Array<{method: string, path: string, body: *}>} */
  requests = []
  /** When set, the next request matching this path returns a 400 with this fault_message. */
  nextFault = null

  /** @param {string} socketPath */
  constructor(socketPath) {
    this.#socketPath = socketPath
    this.#server = http.createServer((req, res) => this.#handle(req, res))
  }

  /** @returns {Promise<void>} */
  async listen() {
    if (existsSync(this.#socketPath)) unlinkSync(this.#socketPath)
    await new Promise((resolve, reject) => {
      this.#server.once('error', reject)
      this.#server.listen(this.#socketPath, () => {
        this.#server.removeListener('error', reject)
        resolve()
      })
    })
  }

  /** @returns {Promise<void>} */
  async close() {
    await new Promise((resolve) => this.#server.close(() => resolve()))
    if (existsSync(this.#socketPath)) unlinkSync(this.#socketPath)
  }

  /**
   * Arrange for the next request to fail with a 400 + fault_message,
   * simulating e.g. a malformed boot-source or an out-of-order action.
   * @param {string} faultMessage
   */
  failNext(faultMessage) {
    this.nextFault = faultMessage
  }

  #handle(req, res) {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body = null
      if (raw.length > 0) {
        try { body = JSON.parse(raw) } catch { body = raw }
      }
      this.requests.push({ method: req.method, path: req.url, body })

      if (this.nextFault) {
        const msg = this.nextFault
        this.nextFault = null
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ fault_message: msg }))
        return
      }

      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        if (req.url === '/') {
          res.end(JSON.stringify({ id: 'fake', state: 'Running', vmm_version: '1.0.0', app_name: 'Firecracker' }))
        } else if (req.url === '/machine-config') {
          res.end(JSON.stringify({ vcpu_count: 1, mem_size_mib: 128, smt: false }))
        } else if (req.url === '/balloon') {
          res.end(JSON.stringify({ amount_mib: 0, deflate_on_oom: false }))
        } else {
          res.end(JSON.stringify({}))
        }
        return
      }

      // PUT / PATCH: Firecracker returns 204 No Content on success.
      res.writeHead(204)
      res.end()
    })
  }
}
