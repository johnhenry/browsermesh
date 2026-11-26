import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmod } from 'node:fs/promises'
import { realmFixture, PP, PASSPHRASE, freshKey } from './realm-helpers.mjs'

describe('realm key custody', () => {
  let fx
  let realm
  let subject
  before(async () => {
    fx = await realmFixture()
    realm = (await fx.ok(['realm', 'create', 'vault', ...PP])).realm.id
    subject = await freshKey()
  })
  after(async () => { await fx.cleanup() })

  const issue = (...extra) => ['realm', 'issue', realm, '--role', 'member', '--key', subject, ...extra]

  it('a wrong passphrase is refused as EACCES (exit 3), with a stable code', async () => {
    const r = await fx.run(issue(...PP), { env: { MESHCTL_TEST_PP: 'not it at all' } })
    assert.equal(r.code, 3)
    assert.equal(r.error.code, 'EREALM_BAD_PASSPHRASE')
    assert.doesNotMatch(r.stderr, /not it at all/)
  })

  it('a missing passphrase option is a usage error', async () => {
    const r = await fx.run(issue())
    assert.equal(r.code, 2)
    assert.equal(r.error.code, 'EUSAGE')
    assert.match(r.error.message, /--passphrase-env|--passphrase-file/)
  })

  it('an unset or empty environment variable is a usage error', async () => {
    for (const value of [undefined, '']) {
      const r = await fx.run(issue(...PP), { env: { MESHCTL_TEST_PP: value } })
      assert.equal(r.code, 2, JSON.stringify(value))
      assert.equal(r.error.code, 'EUSAGE')
    }
  })

  it('the passphrase is never taken from argv: --passphrase is refused, and not echoed', async () => {
    for (const argv of [['--passphrase', 'hunter2hunter2'], ['--passphrase=hunter2hunter2']]) {
      const r = await fx.run(issue(...argv))
      assert.equal(r.code, 2)
      assert.equal(r.error.code, 'EUSAGE')
      assert.doesNotMatch(r.stderr + r.stdout, /hunter2/)
    }
  })

  it('both --passphrase-env and --passphrase-file together is a usage error', async () => {
    const file = await fx.passphraseFile()
    const r = await fx.run(issue(...PP, '--passphrase-file', file))
    assert.equal(r.code, 2)
  })

  it('--passphrase-file works for a file that is mode 0600 (and 0400), trailing newline stripped', async () => {
    for (const mode of [0o600, 0o400]) {
      const file = await fx.passphraseFile(mode)
      const r = await fx.run(issue('--passphrase-file', file))
      assert.equal(r.code, 0, `${mode.toString(8)}: ${r.stderr}`)
    }
  })

  it('--passphrase-file refuses a file that group or others can read', async () => {
    for (const mode of [0o640, 0o644, 0o666, 0o604]) {
      const file = await fx.passphraseFile(mode)
      await chmod(file, mode)
      const r = await fx.run(issue('--passphrase-file', file))
      assert.equal(r.code, 3, mode.toString(8))
      assert.equal(r.error.code, 'EREALM_PASSPHRASE_FILE_MODE')
      assert.doesNotMatch(r.stderr, new RegExp(PASSPHRASE))
    }
  })

  it('a missing or empty --passphrase-file is refused', async () => {
    const missing = await fx.run(issue('--passphrase-file', '/nonexistent/pp'))
    assert.equal(missing.code, 4)
    assert.equal(missing.error.code, 'ENOENT')
    const empty = await fx.passphraseFile(0o600, '\n')
    const r = await fx.run(issue('--passphrase-file', empty))
    assert.equal(r.code, 2)
  })

  it('commands that never sign need no passphrase (ledger, ls, inspect, export)', async () => {
    for (const argv of [['realm', 'ledger', realm], ['realm', 'ls'], ['realm', 'inspect', realm], ['realm', 'export', realm]]) {
      const r = await fx.run(argv, { env: { MESHCTL_TEST_PP: undefined } })
      assert.equal(r.code, 0, `${argv.join(' ')}: ${r.stderr}`)
    }
  })
})
