// The README's tables are checked against the code, so they cannot drift: every refusal code, budget, end reason and link
// code, the scopes, and the defaults.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { REFUSAL_CODES, BUDGET_NAMES, END_REASONS, LINK_CODES, EGRESS_LIMIT_DEFAULTS, EGRESS_SCOPES, DEFAULT_BLOCKED_PORTS, DEFAULT_BLOCKED_UDP_PORTS } from '../src/index.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const readme = await readFile(path.join(root, 'README.md'), 'utf8')
const block = (name) => {
  const m = new RegExp(`<!-- ${name}:begin -->\\n([\\s\\S]*?)\\n<!-- ${name}:end -->`).exec(readme)
  assert.ok(m, `README has no ${name} block`)
  return m[1]
}
const rows = (table) => table.split('\n').filter((l) => l.startsWith('|')).slice(2).map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))
const unticked = (s) => s.replaceAll('`', '')

describe('the README tables are the code\'s lists', () => {
  for (const [name, source] of [['refusals-table', REFUSAL_CODES], ['budgets-table', BUDGET_NAMES], ['ends-table', END_REASONS], ['link-codes-table', LINK_CODES]]) {
    it(`${name}: the same names, in the same words`, () => {
      const table = rows(block(name))
      assert.deepEqual(table.map(([n]) => unticked(n)).sort(), Object.keys(source).sort())
      for (const [n, text] of table) assert.equal(text, source[unticked(n)], `${n}`)
    })
  }

  it('every code the source says is a code of the lists, and every list entry is said somewhere', async () => {
    const used = new Set()
    for (const entry of await readdir(path.join(root, 'src'))) {
      if (!entry.endsWith('.mjs') || entry === 'errors.mjs') continue
      const text = await readFile(path.join(root, 'src', entry), 'utf8')
      for (const m of text.matchAll(/(?:refusalAnswer|new EgressError)\('([a-z-]+)'/g)) used.add(m[1])
      for (const m of text.matchAll(/endConnection\(conn, '([a-z-]+)'/g)) used.add(m[1])
      for (const m of text.matchAll(/budget: '([a-z-]+)'/g)) used.add(m[1])
      for (const m of text.matchAll(/\bcode: '([a-z-]+)'/g)) used.add(m[1])
    }
    const known = new Set([...Object.keys(REFUSAL_CODES), ...Object.keys(LINK_CODES), ...Object.keys(BUDGET_NAMES), ...Object.keys(END_REASONS)])
    assert.deepEqual([...used].filter((u) => !known.has(u)), [], 'said by the source, in no list')
    const never = [...Object.keys(REFUSAL_CODES), ...Object.keys(BUDGET_NAMES), ...Object.keys(END_REASONS)].filter((k) => !used.has(k) && !['unknown', 'connect-failed', 'name-not-found', 'lookup-failed', 'destination-refused', 'bad-request'].includes(k))
    assert.deepEqual(never, [], 'in a list, said by nothing')
  })
})

describe('the scopes and the defaults', () => {
  it('the scope table names exactly the scopes EGRESS_SCOPES builds, and the protocol', () => {
    const named = rows(block('scopes-table')).map(([s]) => unticked(s))
    const built = [
      EGRESS_SCOPES.tcp('<host>', '<port>'), EGRESS_SCOPES.tcpAnyPort('<host>'), EGRESS_SCOPES.dns('<name>'), EGRESS_SCOPES.set('<name>'),
      EGRESS_SCOPES.http('<host>', '<port>'), EGRESS_SCOPES.httpAnyPort('<host>'), EGRESS_SCOPES.setFetch('<name>'),
      EGRESS_SCOPES.udp('<host>', '<port>'), EGRESS_SCOPES.udpAnyPort('<host>'), EGRESS_SCOPES.setUdp('<name>'),
    ]
    assert.deepEqual(named, ['protocol:egress:open', ...built])
  })

  it('the defaults table has every budget the code has, with the values the code has', () => {
    const table = Object.fromEntries(rows(block('defaults-table')).map(([name, value]) => [unticked(name), unticked(value)]))
    const d = EGRESS_LIMIT_DEFAULTS
    // Every limit with a user-facing budget meaning is in the table; these are the housekeeping ones that are not.
    const housekeeping = ['meterIntervalMs', 'maxBadRequests', 'maxViolations', 'streamWindowBytes', 'maxTracked']
    assert.deepEqual(Object.keys(table).sort(), Object.keys(d).filter((k) => !housekeeping.includes(k)).sort())
    const MiB = 1048576
    const say = (k, v) => {
      if (k === 'maxBytesPerConsumer') return `${v.limit / 1073741824} GiB per ${v.windowMs / 3_600_000} hours`
      if (v && typeof v === 'object') return `${v.limit} a ${{ 1000: 'second', 60000: 'minute' }[v.windowMs]}`
      return v >= MiB && v % MiB === 0 ? `${v / MiB} MiB` : String(v)
    }
    for (const [k, v] of Object.entries(table)) assert.equal(v, say(k, d[k]), k)
  })

  it('the blocked ports the README names are the defaults, TCP and UDP', () => {
    assert.deepEqual([...DEFAULT_BLOCKED_PORTS], [25, 465, 587])
    assert.deepEqual([...DEFAULT_BLOCKED_UDP_PORTS], [53])
    assert.match(readme, /`\[25, 465, 587\]`/)
    assert.match(readme, /`\[53\]`/)
  })

  it('the README says plainly what the fetch form exposes, in the places an operator and a consumer read first', () => {
    assert.match(readme, /The fetch form is a different promise: the provider is the HTTP client, so it sees the request and the\s+response in\s+plaintext/)
    assert.match(readme, /With the fetch form on, your machine reads what the consumer fetches/)
    assert.match(readme, /\*\*The provider is the HTTP client, so it sees everything\.\*\*/)
  })

  it('the README no longer lists the fetch form, UDP, the command line or the browser spec as not built', () => {
    const tail = readme.slice(readme.lastIndexOf('## Not in this version yet'))
    for (const word of ['The fetch form (', 'UDP (one destination', 'command-line provider (', 'The browser spec:']) assert.ok(!tail.includes(word), word)
    for (const heading of ['## The fetch form', '## UDP', '## The command line', '## Compatibility with 0.1.1']) assert.ok(readme.includes(heading), heading)
  })
})
