import { test, expect } from './fixtures.mjs'

// End-to-end sealing of routed messages with the browser's own WebCrypto (X25519, HKDF, AES-GCM, Ed25519),
// across two separate browsers: the recipient publishes a signed key statement, the sender verifies it and
// seals to it, and only the recipient opens the result.

const flip = (b64) => (b64[0] === 'A' ? 'B' : 'A') + b64.slice(1)

test('sealing: a message sealed in one browser to a key statement made in another opens only there', async ({ servers, open }) => {
  const sender = await open(servers.a, { isolated: true })
  const recipient = await open(servers.a, { isolated: true })
  const bystander = await open(servers.a, { isolated: true })

  const published = await recipient.evaluate(() => window.bm.sealingPublish())
  expect(published.supported).toBe(true)
  const { statement } = published
  await bystander.evaluate(() => window.bm.sealingPublish())

  const header = 'from|to|message-id-1'
  const secret = 'the launch code is 0451'
  const sealed = await sender.evaluate((args) => window.bm.sealingSeal(...args), [statement, header, secret])
  expect(sealed.refused).toBeUndefined()
  expect(JSON.stringify(sealed.box)).not.toContain('launch code')
  expect(Object.keys(sealed.box).sort()).toEqual(['ct', 'epk', 'iv', 'kid', 'v'])

  const open1 = (page, box, h) => page.evaluate((args) => window.bm.sealingOpen(...args), [box, h])
  expect(await open1(recipient, sealed.box, header)).toEqual({ text: secret })

  // The header is bound: the same box under another header does not open.
  expect(await open1(recipient, sealed.box, 'from|to|message-id-2')).toEqual({ refused: 'open-failed' })
  // Tampering with any part of the box does not open.
  for (const field of ['ct', 'iv', 'epk']) {
    expect(await open1(recipient, { ...sealed.box, [field]: flip(sealed.box[field]) }, header), field).toEqual({ refused: 'open-failed' })
  }
  // A browser holding a different key cannot open it (its key id is not the box's).
  expect((await open1(bystander, sealed.box, header)).refused).toBeTruthy()
})

test('sealing: a key statement not signed by the pod id\'s key, or altered after signing, is refused in the browser', async ({ servers, open }) => {
  const sender = await open(servers.a, { isolated: true })
  const recipient = await open(servers.a, { isolated: true })
  const { statement } = await recipient.evaluate(() => window.bm.sealingPublish())

  const forged = await recipient.evaluate((s) => window.bm.sealingForge(s), statement)
  const seal = (s) => sender.evaluate((args) => window.bm.sealingSeal(...args), [s, 'h', 'x'])
  expect((await seal(forged)).refused).toBe('pod-id-mismatch')
  expect((await seal({ ...statement, notAfter: statement.notAfter + 1000 })).refused).toBe('bad-signature')
  expect((await seal({ ...statement, ka: flip(statement.ka) })).refused).toBe('bad-signature')
  expect((await seal(statement)).refused).toBeUndefined()
})
