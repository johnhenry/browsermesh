import { test, expect } from './fixtures.mjs'

test('the harness runs under a strict policy: no eval, no inline script, isolated', async ({ servers, open, request }) => {
  const res = await request.get(`${servers.a.origin}/`)
  const csp = res.headers()['content-security-policy']
  expect(csp).toContain("script-src 'self' 'nonce-")
  expect(csp).not.toContain('unsafe-eval')
  expect(csp).not.toContain('unsafe-inline')
  expect(csp).not.toContain('wasm-unsafe-eval')

  // The probe page tries eval and new Function on load; blocking them is the point.
  const page = await open(servers.a, { probe: true })
  const facts = await page.evaluate(() => window.bm.policyFacts)
  expect(facts).toEqual({ evalBlocked: true, functionBlocked: true, isolated: true })
})

test('identity: generate, sign and verify with real WebCrypto Ed25519, across two browsers', async ({ servers, open }) => {
  const alice = await open(servers.a, { isolated: true })
  const bob = await open(servers.a, { isolated: true })

  const a = await alice.evaluate(() => window.bm.identityCreate())
  const b = await bob.evaluate(() => window.bm.identityCreate())
  expect(a.podId).not.toEqual(b.podId)
  expect(a.publicKey).not.toEqual(b.publicKey)

  const message = 'alice says hello to the mesh'
  const signature = await alice.evaluate((m) => window.bm.identitySign(m), message)

  // Bob, a different browser with no access to alice's key, verifies using only the public key bytes.
  const verify = (publicKey, sig, text) => bob.evaluate((args) => window.bm.identityVerify(...args), [publicKey, sig, text])
  expect(await verify(a.publicKey, signature, message)).toBe(true)
  expect(await verify(a.publicKey, signature, 'alice says HELLO to the mesh')).toBe(false)
  expect(await verify(b.publicKey, signature, message)).toBe(false)
})
