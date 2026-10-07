/**
 * args.mjs — argv tokenizing and command-grammar resolution for `meshctl
 * <group> <cmd> [args] [flags]`.
 *
 * Deliberately hand-rolled rather than a dependency: the repo convention
 * (`AGENTS.md`) is zero runtime deps beyond sibling workspace packages, and
 * the grammar here (long flags, `--flag value` / `--flag=value`, repeated
 * flags collecting into an array, a `--` separator for `pods exec`/`vm
 * exec`'s inner argv) does not need more than this.
 */

import { UsageError } from './output.mjs'

/** Long flags that never take a value -- `--foo` alone means `true`. */
const BOOLEAN_FLAGS = new Set([
  'json', 'pretty', 'quiet', 'help', 'dry-run', 'cascade', 'loopback',
])

/** Groups whose second token is a subcommand (`meshctl <group> <cmd> ...`). */
const GROUPS_WITH_SUBCOMMAND = new Set(['host', 'pods', 'vm'])

/** Groups with no subcommand (`meshctl <group> [args]`). */
const GROUPS_WITHOUT_SUBCOMMAND = new Set(['identity', 'hosts', 'watch'])

/**
 * @param {Record<string, *>} flags
 * @param {string} name
 * @param {*} value
 */
function setFlag(flags, name, value) {
  if (!(name in flags)) {
    flags[name] = value
    return
  }
  flags[name] = Array.isArray(flags[name]) ? [...flags[name], value] : [flags[name], value]
}

/**
 * Split argv into positionals, long flags, and (after a bare `--`) the raw
 * "rest" tokens `pods exec`/`vm exec` pass straight through as a command.
 *
 * @param {string[]} argv
 * @returns {{positionals: string[], flags: Record<string, *>, rest: string[]}}
 */
export function tokenize(argv) {
  const positionals = []
  /** @type {Record<string, *>} */
  const flags = {}
  const rest = []
  let sawDashDash = false

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (sawDashDash) { rest.push(tok); continue }
    if (tok === '--') { sawDashDash = true; continue }
    if (tok === '-h') { setFlag(flags, 'help', true); continue }

    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=')
      if (eq !== -1) {
        setFlag(flags, tok.slice(2, eq), tok.slice(eq + 1))
        continue
      }
      const name = tok.slice(2)
      if (BOOLEAN_FLAGS.has(name)) {
        setFlag(flags, name, true)
        continue
      }
      const next = argv[i + 1]
      const nextLooksLikeAFlag = next !== undefined && next.startsWith('--') && next !== '--'
      if (next === undefined || nextLooksLikeAFlag) {
        // No value followed -- let the command's own validation (which
        // knows whether this flag was required) report the problem; the
        // tokenizer itself never fails on a bare `--flag`.
        setFlag(flags, name, true)
        continue
      }
      setFlag(flags, name, next)
      i += 1
      continue
    }

    positionals.push(tok)
  }

  return { positionals, flags, rest }
}

/**
 * @typedef {object} ParsedCommand
 * @property {string|null} group
 * @property {string|null} cmd
 * @property {string[]} positionals - Everything after `group [cmd]`.
 * @property {Record<string, *>} flags
 * @property {string[]} rest - Tokens after a bare `--`.
 * @property {boolean} help - `true` for `--help`/`-h`, or no command at all.
 */

/**
 * @param {string[]} argv
 * @returns {ParsedCommand}
 */
export function parseCommand(argv) {
  const { positionals, flags, rest } = tokenize(argv)

  if (flags.help) {
    return { group: null, cmd: null, positionals: [], flags, rest, help: true }
  }

  const [group, maybeSub, ...others] = positionals
  if (!group) {
    return { group: null, cmd: null, positionals: [], flags, rest, help: true }
  }

  if (GROUPS_WITH_SUBCOMMAND.has(group)) {
    if (!maybeSub) throw new UsageError(`'${group}' needs a subcommand`)
    return { group, cmd: maybeSub, positionals: others, flags, rest, help: false }
  }

  if (GROUPS_WITHOUT_SUBCOMMAND.has(group)) {
    const restPositionals = [maybeSub, ...others].filter((v) => v !== undefined)
    return { group, cmd: null, positionals: restPositionals, flags, rest, help: false }
  }

  throw new UsageError(`unknown command '${group}'`)
}
