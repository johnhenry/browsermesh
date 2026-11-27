// #470: a pod id is base64url text and can begin with `-`, `--` or `_`; every form of every id-taking option must accept it.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { UsageError, merge, parseArgv, parseMapping, resolveOptions } from '../src/cli/args.mjs'

const tail = 'A'.repeat(41)
const IDS = { dash: `-x${tail}`, dashdash: `--${tail}`, underscore: `_x${tail}`, plain: `x${tail}` }
const base = ['--signaling', 'wss://signal.example.test']
const resolve = (argv) => resolveOptions(merge({ map: [] }, parseArgv(argv)))

describe('an option value that starts with -- (#470)', () => {
  for (const [label, id] of Object.entries(IDS)) {
    for (const form of ['separate', 'equals']) {
      const pass = (flag, value) => (form === 'separate' ? [flag, value] : [`${flag}=${value}`])
      it(`--map takes a pod id that starts ${label}, ${form} form`, () => {
        const o = resolve([...base, ...pass('--map', `a.test=${id}`)])
        assert.equal(o.mappings[0].peer, id)
        assert.equal(parseArgv(pass('--map', `a.test=${id}#web`)).map[0], `a.test=${id}#web`)
      })
      it(`--names-allow takes a pod id that starts ${label}, ${form} form`, () => {
        const o = resolve([...base, '--names-zone', 'pods.example.test', ...pass('--names-allow', `${id}=*`)])
        assert.equal(o.names.allow[0].pod, id)
      })
    }
  }

  it('every option that needs a value takes a next argument that starts with -- (or -) as its value', () => {
    for (const flag of ['listen', 'signaling', 'map', 'allow-methods', 'max-body', 'timeout', 'upload-timeout', 'max-uploads', 'auth', 'identity',
      'config', 'link-wait', 'ready-path', 'names-zone', 'names-allow', 'names-deny', 'names-max', 'names-max-per-pod', 'names-hold']) {
      for (const value of ['--zz', '-zz', '--zz=1']) assert.equal([].concat(parseArgv([`--${flag}`, value])[flag])[0], value, `${flag} ${value}`)
    }
  })

  it('a value that is itself a known option is a missing value: --opt --known and --opt --known=x', () => {
    for (const argv of [['--map', '--listen'], ['--names-allow', '--public'], ['--listen', '--map=a=b'], ['--timeout', '-h'], ['--map', '--help']]) {
      assert.throws(() => parseArgv(argv), (e) => e instanceof UsageError && /needs a value\.$/.test(e.message), argv.join(' '))
    }
  })

  it('a value missing at the end of the arguments is still reported', () => {
    for (const argv of [['--map'], ['--names-allow'], ['--listen', 'a:1', '--map']]) {
      assert.throws(() => parseArgv(argv), (e) => e instanceof UsageError && /needs a value\.$/.test(e.message), argv.join(' '))
    }
  })

  it('the next argument after a consumed -- value is parsed normally', () => {
    const o = parseArgv(['--map', `a.test=${IDS.dashdash}`, '--public'])
    assert.equal(o.public, true)
    assert.equal(parseMapping(o.map[0]).peer, IDS.dashdash)
  })
})
