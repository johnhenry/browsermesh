import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runCli } from './helpers.mjs'
import { EXIT_CODE } from '../src/output.mjs'

describe('meshctl usage errors', () => {
  it('no command at all prints the usage document and exits 0', async () => {
    const { code, stdout } = await runCli([])
    assert.equal(code, EXIT_CODE.OK)
    const doc = JSON.parse(stdout)
    assert.equal(doc.ok, true)
    assert.equal(doc.result.name, 'meshctl')
    assert.ok(Array.isArray(doc.result.commands))
  })

  it('--help prints the usage document and exits 0', async () => {
    const { code, stdout } = await runCli(['--help'])
    assert.equal(code, EXIT_CODE.OK)
    const doc = JSON.parse(stdout)
    assert.equal(doc.ok, true)
    assert.ok(doc.result.commands.some((c) => c.startsWith('pods spawn')))
    assert.deepEqual(doc.result.exitCodes, EXIT_CODE)
  })

  it('-h is a synonym for --help', async () => {
    const { code, stdout } = await runCli(['-h'])
    assert.equal(code, EXIT_CODE.OK)
    assert.equal(JSON.parse(stdout).result.name, 'meshctl')
  })

  it('unknown group exits 2 with a JSON error on stderr', async () => {
    const { code, stdout, stderr } = await runCli(['bogus'])
    assert.equal(code, EXIT_CODE.USAGE)
    assert.equal(stdout, '')
    const doc = JSON.parse(stderr)
    assert.equal(doc.ok, false)
    assert.equal(doc.error.code, 'EUSAGE')
  })

  it('a group needing a subcommand without one exits 2', async () => {
    const { code, stderr } = await runCli(['pods'])
    assert.equal(code, EXIT_CODE.USAGE)
    assert.equal(JSON.parse(stderr).error.code, 'EUSAGE')
  })

  it('pods spawn without --loopback/--signaling exits 2 (connection mode required)', async () => {
    const { code, stderr } = await runCli(['pods', 'spawn', 'auto', '--name', 'x', '--lane', 'node', '--kind', 'command', '--ref', '/bin/sh'])
    assert.equal(code, EXIT_CODE.USAGE)
    assert.match(JSON.parse(stderr).error.message, /--loopback or --signaling/)
  })

  it('--loopback and --signaling together exits 2', async () => {
    const { code, stderr } = await runCli(['hosts', '--loopback', '--signaling', 'ws://example.invalid'])
    assert.equal(code, EXIT_CODE.USAGE)
    assert.match(JSON.parse(stderr).error.message, /mutually exclusive/)
  })

  it('vm without --dry-run exits 2', async () => {
    const { code, stderr } = await runCli(['vm', 'spawn', 'demo'])
    assert.equal(code, EXIT_CODE.USAGE)
    assert.match(JSON.parse(stderr).error.message, /--dry-run/)
  })

  it('vm unknown subcommand exits 2', async () => {
    const { code, stderr } = await runCli(['vm', 'bogus', 'demo', '--dry-run'])
    assert.equal(code, EXIT_CODE.USAGE)
    assert.equal(JSON.parse(stderr).error.code, 'EUSAGE')
  })
})
