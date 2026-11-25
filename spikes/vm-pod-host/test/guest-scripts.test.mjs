// The guest's shell scripts are never executed outside a real guest or a Linux
// build host, so the least that can be checked anywhere is that they parse.
// (`sh -n`: read the script, run nothing.)
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const have = spawnSync('sh', ['-c', 'true']).status === 0

describe('guest scripts', { skip: have ? false : 'no sh on this platform' }, () => {
  for (const name of ['init', 'build-rootfs.sh']) {
    it(`${name} parses as POSIX sh`, () => {
      const file = fileURLToPath(new URL(`../guest/${name}`, import.meta.url))
      const result = spawnSync('sh', ['-n', file], { encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
    })
  }
})
