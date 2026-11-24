// A hosted module that imports something: the isolate lane refuses it at start.
import fs from 'node:fs'

export async function handle() {
  return typeof fs
}
