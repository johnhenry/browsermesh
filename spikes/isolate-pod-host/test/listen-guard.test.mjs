import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { isLoopbackAddress, controlAuthProblem } from '../src/listen-guard.mjs'
import { handlePodHostRequest } from '../src/routes.mjs'
import { buildServeCommand } from '../src/serve.mjs'

describe('isLoopbackAddress', () => {
  it('accepts only loopback addresses, with or without a port', () => {
    for (const address of ['127.0.0.1', '127.0.0.1:8080', '127.1.2.3:80', 'localhost', 'localhost:8080', '::1', '[::1]:8080']) {
      assert.equal(isLoopbackAddress(address), true, address)
    }
  })

  it('treats everything else, and anything it cannot parse, as not loopback', () => {
    for (const address of [
      '0.0.0.0', '0.0.0.0:8080', '*', '*:8080', ':8080', '', '::', '[::]:8080', '10.0.0.5:8080', '192.168.1.2',
      'example.com:80', '127.0.0.1.evil.com', '127.0.0.1@evil.com', 'localhost.evil.com', '128.0.0.1', undefined, null, 8080,
    ]) {
      assert.equal(isLoopbackAddress(address), false, String(address))
    }
  })
})

describe('controlAuthProblem', () => {
  it('a loopback listener needs no token', () => {
    assert.equal(controlAuthProblem({ address: '127.0.0.1:8080' }), null)
  })

  it('a listener beyond loopback needs a control token, and says why it refuses', () => {
    for (const token of [undefined, null, '']) {
      assert.match(controlAuthProblem({ address: '0.0.0.0:8080', token }), /CONTROL_TOKEN is required.*0\.0\.0\.0:8080/)
    }
    assert.equal(controlAuthProblem({ address: '0.0.0.0:8080', token: 's3cret' }), null)
  })

  it('no stated address is not a reason to refuse (the platform decides where it listens)', () => {
    assert.equal(controlAuthProblem({}), null)
  })
})

describe('the launcher', () => {
  it('refuses to start beyond loopback without a token, naming the reason', () => {
    assert.throws(
      () => buildServeCommand({ address: '0.0.0.0:8080', env: {} }),
      /refusing to start: CONTROL_TOKEN is required.*0\.0\.0\.0:8080/,
    )
    assert.throws(() => buildServeCommand({ address: '0.0.0.0:8080', env: { CONTROL_TOKEN: '' } }), /refusing to start/)
  })

  it('starts on loopback with no token, and anywhere with one, telling the Worker where it listens', () => {
    const loopback = buildServeCommand({ env: {} })
    assert.equal(loopback.command, 'workerd')
    assert.ok(loopback.args.includes('--socket-addr=http=127.0.0.1:8080'))
    assert.equal(loopback.env.LISTEN_ADDRESS, '127.0.0.1:8080')
    const open = buildServeCommand({ address: '0.0.0.0:9000', env: { CONTROL_TOKEN: 't' } })
    assert.ok(open.args.includes('--socket-addr=http=0.0.0.0:9000'))
    assert.equal(open.env.LISTEN_ADDRESS, '0.0.0.0:9000')
  })
})

describe('the control routes fail closed on a non-loopback listener without a token', () => {
  const env = (extra) => ({ POD: { idFromName: (n) => n, get: () => ({ fetch: async () => Response.json({}) }) }, ...extra })

  it('every route but /health is refused with 503', async () => {
    const e = env({ LISTEN_ADDRESS: '0.0.0.0:8080' })
    assert.equal((await handlePodHostRequest(new Request('http://x/health'), e)).status, 200)
    const refused = await handlePodHostRequest(new Request('http://x/pods'), e)
    assert.equal(refused.status, 503)
    assert.match((await refused.json()).message, /CONTROL_TOKEN is required/)
  })

  it('a token, or a loopback address, lets the routes work as before', async () => {
    const withToken = env({ LISTEN_ADDRESS: '0.0.0.0:8080', CONTROL_TOKEN: 'tok' })
    assert.equal((await handlePodHostRequest(new Request('http://x/pods'), withToken)).status, 401)
    const authed = await handlePodHostRequest(new Request('http://x/pods', { headers: { authorization: 'Bearer tok' } }), withToken)
    assert.notEqual(authed.status, 401)
    assert.notEqual(authed.status, 503)
    const loopback = env({ LISTEN_ADDRESS: '127.0.0.1:8080' })
    assert.notEqual((await handlePodHostRequest(new Request('http://x/pods'), loopback)).status, 503)
  })
})
