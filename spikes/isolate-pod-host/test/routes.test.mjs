/**
 * routes.test.mjs — the isolate pod host's HTTP route table plus the
 * Node-side `createIsolatePodDriver()` that drives it, exercised end to
 * end in plain `node --test` (issue #185's hosted-pods control surface).
 *
 * No `cf dev`, no workerd, no network: `routes.mjs` takes an `env`
 * whose `POD` is a Durable Object namespace, and this file supplies a fake
 * one whose stubs answer the same `/boot` `/status` `/send` `/drain`
 * `/roster*` contract `pod-object.mjs` implements. The real DO is covered
 * by `isolate-pod.test.mjs`'s cf dev end-to-end suite; what is covered
 * HERE is the route table and the driver's error translation, which are
 * the parts the rest of the mesh talks to.
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { handlePodHostRequest } from '../src/routes.mjs'
import { createIsolatePodDriver } from '../src/driver.mjs'
import { POD_HOST_ERROR, POD_LANE, POD_LIFECYCLE } from '@johnhenry/browsermesh-pod'

/**
 * A fake Durable Object namespace: one in-memory object per `idFromName`,
 * answering the same routes `pod-object.mjs` does.
 */
function fakeNamespace() {
  /** @type {Map<string, object>} */
  const instances = new Map()

  function instanceFor(id) {
    let instance = instances.get(id)
    if (!instance) {
      instance = { record: null, roster: [], peers: [], sent: [] }
      instances.set(id, instance)
    }
    return instance
  }

  return {
    instances,
    idFromName(name) { return name },
    get(id) {
      const instance = instanceFor(id)
      return {
        async fetch(request) {
          const url = new URL(request.url)
          if (url.pathname === '/roster') return Response.json({ names: instance.roster })
          if (url.pathname === '/roster/add') {
            const { name } = await request.json()
            if (!instance.roster.includes(name)) instance.roster.push(name)
            return Response.json({ names: instance.roster })
          }
          if (url.pathname === '/roster/remove') {
            const { name } = await request.json()
            instance.roster = instance.roster.filter((entry) => entry !== name)
            return Response.json({ names: instance.roster })
          }
          if (url.pathname === '/boot') {
            const { name, spec, discoveryWindowMs } = await request.json()
            instance.boots = [...(instance.boots ?? []), { discoveryWindowMs }]
            instance.record = {
              name, lane: POD_LANE.ISOLATE, state: POD_LIFECYCLE.REGISTERED, spec,
              createdAt: 1, updatedAt: 2,
            }
            return Response.json({ ...instance.record, podId: `pod-${name}`, peers: [], booted: true })
          }
          if (url.pathname === '/status') {
            if (!instance.record) {
              return Response.json({
                name: null, lane: POD_LANE.ISOLATE, state: POD_LIFECYCLE.COLD, spec: null,
                createdAt: 0, updatedAt: 0, podId: null, peers: [], booted: false,
              })
            }
            return Response.json({
              ...instance.record,
              podId: instance.record.state === POD_LIFECYCLE.GONE ? null : `pod-${instance.record.name}`,
              peers: instance.peers,
              booted: instance.record.state === POD_LIFECYCLE.REGISTERED,
            })
          }
          if (url.pathname === '/send') {
            instance.sent.push(await request.json())
            return Response.json({ ok: true, sentAtMs: 3 })
          }
          if (url.pathname === '/drain') {
            if (instance.record) instance.record = { ...instance.record, state: POD_LIFECYCLE.GONE }
            return Response.json({
              ...(instance.record || {}), podId: null, peers: [], booted: false,
            })
          }
          return Response.json({ code: 'ENOENT', message: 'not found' }, { status: 404 })
        },
      }
    },
  }
}

/** A `fetch` that routes straight into `handlePodHostRequest()`. */
function fetchInto(env) {
  return async (url, init) => handlePodHostRequest(new Request(url, init), env)
}

function spec(overrides = {}) {
  return { name: 'alpha', lane: POD_LANE.ISOLATE, run: { kind: 'skill', ref: 'greeter' }, ...overrides }
}

describe('isolate pod host routes', () => {
  /** @type {any} */ let env
  /** @type {any} */ let driver

  beforeEach(() => {
    env = { POD: fakeNamespace() }
    driver = createIsolatePodDriver({ baseUrl: 'http://host', fetch: fetchInto(env) })
  })

  it('requires a baseUrl and a fetch', () => {
    assert.throws(() => createIsolatePodDriver(), /baseUrl is required/)
    assert.throws(() => createIsolatePodDriver({ baseUrl: 'http://x', fetch: 'nope' }), /no fetch available/)
  })

  it('advertises the isolate lane and its five verbs', () => {
    assert.equal(driver.lane, POD_LANE.ISOLATE)
    assert.deepEqual(driver.capabilities().verbs, ['spawn', 'status', 'send', 'drain', 'list'])
  })

  it('answers GET /health', async () => {
    const response = await handlePodHostRequest(new Request('http://host/health'), env)
    assert.deepEqual(await response.json(), { status: 'ok' })
  })

  it('spawns, statuses, sends, lists and drains', async () => {
    const spawned = await driver.spawn(spec())
    assert.equal(spawned.name, 'alpha')
    assert.equal(spawned.state, POD_LIFECYCLE.REGISTERED)
    assert.equal(spawned.spec.run.ref, 'greeter')

    assert.equal((await driver.status('alpha')).booted, true)
    assert.deepEqual(await driver.send('alpha', { to: 'peer-1', payload: { hi: true } }), {
      ok: true, sentAtMs: 3,
    })
    assert.deepEqual(env.POD.instances.get('alpha').sent, [{ to: 'peer-1', payload: { hi: true } }])

    const list = await driver.list()
    assert.deepEqual(list.map((pod) => pod.name), ['alpha'])

    assert.equal((await driver.drain('alpha')).state, POD_LIFECYCLE.GONE)
    assert.deepEqual(await driver.list(), [])
  })

  it('a wake passes the short discovery window to the pod object; a first spawn passes none', async () => {
    await driver.spawn(spec({ name: 'first' }))
    await driver.spawn(spec({ name: 'woken' }), { wake: { discoveryWindowMs: 40, podId: 'x' } })
    await driver.spawn(spec({ name: 'bad' }), { wake: { discoveryWindowMs: -1 } })
    const windows = (name) => env.POD.instances.get(name).boots.map((b) => b.discoveryWindowMs ?? null)
    assert.deepEqual(windows('first'), [null])
    assert.deepEqual(windows('woken'), [40])
    assert.deepEqual(windows('bad'), [null], 'a window that is not a non-negative integer is not sent')
  })

  it('normalizes the podspec before storing it, and the URL wins on name', async () => {
    const response = await handlePodHostRequest(new Request('http://host/pods/beta/boot', {
      method: 'POST',
      body: JSON.stringify({ name: 'something-else', run: { kind: 'skill', ref: 'greeter' } }),
    }), env)
    const body = await response.json()
    assert.equal(body.name, 'beta')
    // lane was defaulted from run.kind, restart.policy from nothing.
    assert.equal(body.spec.lane, POD_LANE.ISOLATE)
    assert.equal(body.spec.restart.policy, 'never')
  })

  it('boots with no body at all, the way the WP2 end-to-end test does', async () => {
    const response = await handlePodHostRequest(new Request('http://host/pods/alpha/boot', { method: 'POST' }), env)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).spec, null)
  })

  it('rejects an invalid podspec with 400 EINVAL and a non-isolate lane with 409 ELANE', async () => {
    const bad = await handlePodHostRequest(new Request('http://host/pods/alpha/boot', {
      method: 'POST', body: JSON.stringify({ run: { kind: 'nope', ref: 'x' } }),
    }), env)
    assert.equal(bad.status, 400)
    assert.equal((await bad.json()).code, POD_HOST_ERROR.EINVAL)

    const wrongLane = await handlePodHostRequest(new Request('http://host/pods/alpha/boot', {
      method: 'POST', body: JSON.stringify({ lane: 'microvm', run: { kind: 'command', ref: 'x' } }),
    }), env)
    assert.equal(wrongLane.status, 409)
    assert.equal((await wrongLane.json()).code, POD_HOST_ERROR.ELANE)

    const notJson = await handlePodHostRequest(new Request('http://host/pods/alpha/boot', {
      method: 'POST', body: 'not json',
    }), env)
    assert.equal(notJson.status, 400)
  })

  it('refuses a non-isolate podspec client-side too, before any HTTP', async () => {
    await assert.rejects(
      driver.spawn({ name: 'alpha', lane: 'microvm', run: { kind: 'command', ref: 'x' } }),
      (err) => err.code === POD_HOST_ERROR.ELANE,
    )
    await assert.rejects(driver.spawn({ name: 'bad name' }), (err) => err.code === POD_HOST_ERROR.EINVAL)
  })

  it('answers exec with 405 ELANE', async () => {
    await driver.spawn(spec())
    const response = await handlePodHostRequest(
      new Request('http://host/pods/alpha/exec', { method: 'POST', body: '{}' }), env,
    )
    assert.equal(response.status, 405)
    assert.equal((await response.json()).code, POD_HOST_ERROR.ELANE)
    await assert.rejects(driver.exec('alpha', ['ls']), (err) => {
      assert.equal(err.code, POD_HOST_ERROR.ELANE)
      assert.match(err.message, /has no shell/)
      return true
    })
  })

  it('answers snapshot and restore with 501 ENOTSUP', async () => {
    await driver.spawn(spec())
    for (const verb of ['snapshot', 'restore']) {
      const response = await handlePodHostRequest(
        new Request(`http://host/pods/alpha/${verb}`, { method: 'POST' }), env,
      )
      assert.equal(response.status, 501)
      assert.equal((await response.json()).code, POD_HOST_ERROR.ENOTSUP)
    }
    await assert.rejects(driver.snapshot('alpha'), (err) => err.code === POD_HOST_ERROR.ENOTSUP)
    await assert.rejects(driver.restore('alpha'), (err) => err.code === POD_HOST_ERROR.ENOTSUP)
  })

  it('translates a never-addressed pod into ENOENT', async () => {
    await assert.rejects(driver.status('ghost'), (err) => err.code === POD_HOST_ERROR.ENOENT)
  })

  it('rejects unknown paths and wrong methods', async () => {
    const notFound = await handlePodHostRequest(new Request('http://host/nope'), env)
    assert.equal(notFound.status, 404)
    const wrongMethod = await handlePodHostRequest(new Request('http://host/pods/alpha/status', { method: 'POST' }), env)
    assert.equal(wrongMethod.status, 405)
    const wrongListMethod = await handlePodHostRequest(new Request('http://host/pods', { method: 'POST' }), env)
    assert.equal(wrongListMethod.status, 405)
    const wrongDrainMethod = await handlePodHostRequest(new Request('http://host/pods/alpha', { method: 'GET' }), env)
    assert.equal(wrongDrainMethod.status, 405)
  })

  describe('control token (CONTROL_TOKEN)', () => {
    const TOKEN = 'a-long-random-control-token'
    const request = (path, init = {}) => new Request(`http://host${path}`, init)

    it('without a configured token the routes behave as before', async () => {
      const response = await handlePodHostRequest(request('/pods'), env)
      assert.equal(response.status, 200)
    })

    it('with a token configured, every route but /health refuses a request without it', async () => {
      env.CONTROL_TOKEN = TOKEN
      for (const [method, path] of [
        ['GET', '/pods'], ['POST', '/pods/alpha/boot'], ['GET', '/pods/alpha/status'],
        ['POST', '/pods/alpha/send'], ['DELETE', '/pods/alpha'], ['POST', '/pods/alpha/exec'],
        ['GET', '/nope'],
      ]) {
        const response = await handlePodHostRequest(request(path, { method, body: method === 'POST' ? '{}' : undefined }), env)
        assert.equal(response.status, 401, `${method} ${path}`)
        assert.equal((await response.json()).code, POD_HOST_ERROR.EACCES)
      }
      assert.equal(env.POD.instances.size, 0, 'a refused request reaches no pod')
      assert.equal((await handlePodHostRequest(request('/health'), env)).status, 200)
    })

    it('refuses a wrong, a differently-cased, a prefix and a longer token, and a non-bearer scheme', async () => {
      env.CONTROL_TOKEN = TOKEN
      for (const authorization of [
        'Bearer wrong', `Bearer ${TOKEN.toUpperCase()}`, `Bearer ${TOKEN.slice(0, -1)}`, `Bearer ${TOKEN}x`,
        `Basic ${TOKEN}`, TOKEN, 'Bearer ', '',
      ]) {
        const response = await handlePodHostRequest(request('/pods', { headers: { authorization } }), env)
        assert.equal(response.status, 401, JSON.stringify(authorization))
      }
    })

    it('accepts the right token, and the driver sends it when given one', async () => {
      env.CONTROL_TOKEN = TOKEN
      const ok = await handlePodHostRequest(request('/pods', { headers: { authorization: `Bearer ${TOKEN}` } }), env)
      assert.equal(ok.status, 200)

      const withToken = createIsolatePodDriver({ baseUrl: 'http://host', fetch: fetchInto(env), token: TOKEN })
      assert.equal((await withToken.spawn(spec())).state, POD_LIFECYCLE.REGISTERED)
      await assert.rejects(driver.list(), (err) => err.code === POD_HOST_ERROR.EACCES)
    })

    it('an empty CONTROL_TOKEN counts as not configured (an unset secret binding)', async () => {
      env.CONTROL_TOKEN = ''
      const response = await handlePodHostRequest(request('/pods'), env)
      assert.equal(response.status, 200)
    })
  })

  it('reports an unreachable host as ETIMEDOUT rather than a pod-level error', async () => {
    const offline = createIsolatePodDriver({
      baseUrl: 'http://host',
      fetch: async () => { throw new Error('connect ECONNREFUSED') },
    })
    await assert.rejects(offline.list(), (err) => {
      assert.equal(err.code, POD_HOST_ERROR.ETIMEDOUT)
      assert.match(err.message, /unreachable/)
      return true
    })
  })
})
