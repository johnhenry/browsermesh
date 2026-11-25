// The "memory per idle VM" number of issue #185 section 9, read from the VMM's
// /proc status the way the real Firecracker test reports it.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parseVmRssKb, readVmmRssKb } from './real/vmm-rss.mjs'

const STATUS = 'Name:\tfirecracker\nUmask:\t0022\nVmPeak:\t  900000 kB\nVmRSS:\t   19456 kB\nRssAnon:\t    3000 kB\nThreads:\t5\n'

describe('VMM resident memory', () => {
  it('reads VmRSS in kB from a /proc/<pid>/status text, and not VmPeak or RssAnon', () => {
    assert.equal(parseVmRssKb(STATUS), 19456)
  })

  it('is null for a status without VmRSS (a kernel thread, or a process that is gone)', () => {
    assert.equal(parseVmRssKb('Name:\tkthreadd\n'), null)
    assert.equal(parseVmRssKb(''), null)
  })

  it('reads the pid from the jailer pid file and then that process\'s status', async () => {
    const read = []
    const readFile = async (file) => {
      read.push(file)
      return file.endsWith('.pid') ? '4242\n' : STATUS
    }
    assert.equal(await readVmmRssKb('/jail/firecracker.pid', { readFile }), 19456)
    assert.deepEqual(read, ['/jail/firecracker.pid', '/proc/4242/status'])
  })

  it('is null, not a throw, when the pid file or the process is not there', async () => {
    const missing = async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }) }
    assert.equal(await readVmmRssKb('/jail/firecracker.pid', { readFile: missing }), null)
    assert.equal(await readVmmRssKb('/jail/firecracker.pid', { readFile: async (f) => (f.endsWith('.pid') ? 'not a pid' : STATUS) }), null)
  })
})
