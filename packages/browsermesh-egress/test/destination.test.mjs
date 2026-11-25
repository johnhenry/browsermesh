// What a destination is: host syntax, ports, scopes, and the operator's sets.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { checkHost, checkName, checkPort, compileSets, entryMatches, looksLikePodId, parseSetEntry, setsCovering, EGRESS_SCOPES } from '../src/destination.mjs'

const refused = (fn) => assert.throws(fn, (e) => e.code === 'bad-destination')

describe('a destination host', () => {
  it('accepts a lowercase DNS name and a canonical IPv4 dotted quad', () => {
    assert.deepEqual(checkHost('registry.example.com'), { host: 'registry.example.com', kind: 'name' })
    assert.deepEqual(checkHost('a-b.c1.example'), { host: 'a-b.c1.example', kind: 'name' })
    assert.deepEqual(checkHost('203.0.113.7'), { host: '203.0.113.7', kind: 'ipv4' })
    assert.deepEqual(checkHost('localhost'), { host: 'localhost', kind: 'name' })
  })

  it('refuses every other spelling of an address, so no rule sees two spellings of one address', () => {
    for (const h of ['127.1', '0177.0.0.1', '0x7f.0.0.1', '0x7f.1', '2130706433', '127.0.0.01', '1.2.3', '1.2.3.4.5', '256.1.1.1', '01.1.1.1', '0x7f000001']) refused(() => checkHost(h))
  })

  it('refuses upper case, a trailing dot, empty labels, ports, paths, userinfo, IPv6 and anything that is not a hostname', () => {
    for (const h of ['Example.com', 'example.com.', 'a..b', '.a', 'example.com:443', 'a/b', 'u@example.com', '::1', '[::1]', '::ffff:10.0.0.1', 'a b', 'ex_ample.com', '-a.com', 'a-.com', '', 'a'.repeat(64) + '.com', 'é.com', '*.example.com', '*']) refused(() => checkHost(h))
    refused(() => checkHost('a.'.repeat(130) + 'com'))
    refused(() => checkHost(undefined))
    refused(() => checkHost(443))
  })

  it('a name to look up is a name, never an address', () => {
    assert.equal(checkName('example.com'), 'example.com')
    refused(() => checkName('203.0.113.7'))
  })

  it('a port is a whole number from 1 to 65535', () => {
    assert.equal(checkPort(443), 443)
    for (const p of [0, 65536, -1, 1.5, '443', NaN, undefined]) refused(() => checkPort(p))
  })

  it('knows a mesh pod id when it sees one', () => {
    assert.ok(looksLikePodId('A'.repeat(43)))
    assert.ok(looksLikePodId('abc_-ABC'.repeat(5) + 'abc'))
    assert.ok(!looksLikePodId('example.com'))
    assert.ok(!looksLikePodId('A'.repeat(42)))
  })
})

describe('the scopes a grant is written in', () => {
  it('are the ones the design names, and never contain a segment that could be a second scope', () => {
    assert.equal(EGRESS_SCOPES.tcp('pkg.test', 443), 'egress:tcp:pkg.test:443:connect')
    assert.equal(EGRESS_SCOPES.tcpAnyPort('pkg.test'), 'egress:tcp:pkg.test:*:connect')
    assert.equal(EGRESS_SCOPES.dns('pkg.test'), 'egress:dns:pkg.test:resolve')
    assert.equal(EGRESS_SCOPES.set('pkgs'), 'egress:set:pkgs:connect')
  })
})

describe('an operator\'s destination set', () => {
  const match = (entry, host, port) => { const { host: h, kind } = checkHost(host); return entryMatches(parseSetEntry(entry), h, kind, port) }

  it('an exact name matches that name on its ports, and nothing else', () => {
    assert.ok(match('registry.npmjs.org:443', 'registry.npmjs.org', 443))
    assert.ok(!match('registry.npmjs.org:443', 'registry.npmjs.org', 80))
    assert.ok(!match('registry.npmjs.org:443', 'www.registry.npmjs.org', 443))
    assert.ok(!match('registry.npmjs.org:443', 'npmjs.org', 443))
  })

  it('a *.suffix matches subdomains at any depth and never the apex or a look-alike', () => {
    assert.ok(match('*.alpinelinux.org:80,443', 'dl-cdn.alpinelinux.org', 80))
    assert.ok(match('*.alpinelinux.org:80,443', 'a.b.alpinelinux.org', 443))
    assert.ok(!match('*.alpinelinux.org:80,443', 'alpinelinux.org', 443))
    assert.ok(!match('*.alpinelinux.org:80,443', 'evilalpinelinux.org', 443))
    assert.ok(!match('*.alpinelinux.org:80,443', 'alpinelinux.org.evil.test', 443))
    assert.ok(!match('*.alpinelinux.org:80,443', 'dl.alpinelinux.org', 8080))
  })

  it('port lists, ranges and * are all there is', () => {
    assert.ok(match('a.test:8000-8100', 'a.test', 8050))
    assert.ok(!match('a.test:8000-8100', 'a.test', 8101))
    assert.ok(match('a.test:22,80,8000-8001', 'a.test', 8001))
    assert.ok(match('a.test:*', 'a.test', 65535))
  })

  it('an IPv4 literal and an IPv4 block match destinations given as IP literals only', () => {
    assert.ok(match('203.0.113.7:443', '203.0.113.7', 443))
    assert.ok(!match('203.0.113.7:443', '203.0.113.8', 443))
    assert.ok(match('203.0.113.0/24:443', '203.0.113.200', 443))
    assert.ok(!match('203.0.113.0/24:443', '203.0.114.1', 443))
    assert.ok(match('0.0.0.0/0:443', '8.8.8.8', 443))
    assert.ok(match('203.0.113.7/32:1-65535', '203.0.113.7', 5))
    assert.ok(!match('203.0.113.0/24:443', 'host.test', 443), 'a name is not looked up to see whether it falls in a block')
    assert.ok(!match('host.test:443', '203.0.113.7', 443))
  })

  it('refuses at construction what would be wide access, and what it cannot read', () => {
    for (const bad of ['*:443', '*:*', '*.com:443', '*.*.test:443', 'a*.test:443', 'ex*.test:80', '*.test.:443', 'host.test', 'host.test:', 'host.test:0', 'host.test:70000', 'host.test:90-80', 'host.test:80,', '::1:443', '[::1]:443', '10.0.0.0/33:443', '10.0.0.1/24:443', '10.0.0.0/8/8:443', '0x7f.1:80', 'UPPER.test:443', '', 5]) {
      assert.throws(() => parseSetEntry(bad), TypeError, String(bad))
    }
  })

  it('a set is named like a scope segment, and has entries', () => {
    const compiled = compileSets({ pkgs: ['a.test:443'], 'os-mirrors.v2': ['b.test:80'] })
    assert.deepEqual([...compiled.keys()], ['pkgs', 'os-mirrors.v2'])
    for (const bad of [{ 'a:b': ['a.test:1'] }, { '*': ['a.test:1'] }, { Upper: ['a.test:1'] }, { empty: [] }, { str: 'a.test:1' }, [], null]) assert.throws(() => compileSets(bad), TypeError)
    assert.equal(compileSets().size, 0)
  })

  it('finds the sets that list a destination', () => {
    const compiled = compileSets({ one: ['a.test:443'], two: ['*.x.test:443', 'b.test:80'], three: ['9.9.9.0/24:53'] })
    assert.deepEqual(setsCovering(compiled, 'a.test', 'name', 443), ['one'])
    assert.deepEqual(setsCovering(compiled, 'a.test', 'name', 80), [])
    assert.deepEqual(setsCovering(compiled, 'y.x.test', 'name', 443), ['two'])
    assert.deepEqual(setsCovering(compiled, '9.9.9.9', 'ipv4', 53), ['three'])
  })
})
