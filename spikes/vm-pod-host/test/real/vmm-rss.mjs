// Resident memory of a VMM process, for the real Firecracker test's report.
import { readFile as fsReadFile } from 'node:fs/promises'

/**
 * @param {string} statusText - the contents of /proc/<pid>/status
 * @returns {number|null} VmRSS in kB, or null when the status has none
 */
export function parseVmRssKb(statusText) {
  const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(String(statusText))
  return match ? Number(match[1]) : null
}

/**
 * @param {string} pidFile - the jailer's pid file for the VMM
 * @param {{ readFile?: (file: string) => Promise<string|Buffer> }} [opts]
 * @returns {Promise<number|null>} VmRSS in kB, or null when it cannot be read
 */
export async function readVmmRssKb(pidFile, { readFile = (file) => fsReadFile(file, 'utf8') } = {}) {
  try {
    const raw = String(await readFile(pidFile)).trim()
    if (!/^\d+$/.test(raw) || Number(raw) <= 1) return null
    return parseVmRssKb(await readFile(`/proc/${raw}/status`))
  } catch {
    return null
  }
}
