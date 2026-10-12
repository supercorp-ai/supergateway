import { Parser } from 'yargs/helpers'
import { cli } from './cliOptions.js'

// The name yargs files an option under. It camel-cases a name only when it has
// a hyphen in it, so `--log-level` and `--LOG-LEVEL` set `logLevel`, while
// `--STDIO` and `--log_level` stay options of their own that nothing reads.
const canonical = (name: string) =>
  name.includes('-') ? Parser.camelCase(name) : name

// `getOptions` is public on a yargs 17 instance but missing from its types.
type Declarations = {
  getOptions(): { key: Record<string, unknown> }
}

// What the command line declares, including yargs' own `--help` and
// `--version`, and the two keys every parse adds: `_` and `$0`.
const declaredOptions = () => {
  const { key } = (cli([]) as unknown as Declarations).getOptions()
  return new Set([...Object.keys(key), '_', '$0'].map(canonical))
}

// Each option name as typed, with the spelling to report it by. `-xy` is two
// short options, `--no-x` is `x` negated, and `--x=1` carries its own value.
// Only spells what yargs parsed: which options are unknown comes from the
// parse, so the `--foo` inside a quoted `--stdio "node x --foo"` never warns.
const typedOptions = (args: string[]) =>
  args.flatMap((arg) => {
    const long = /^--([^=]+)/.exec(arg)
    if (long)
      return [long[1], long[1].replace(/^no-/, '')].map((name) => ({
        name: canonical(name),
        spelling: `--${long[1]}`,
      }))
    return arg.startsWith('-')
      ? [...arg.slice(1)].map((name) => ({ name, spelling: `-${name}` }))
      : []
  })

/** The declared options the command line actually gives, as yargs files them. */
export function givenOptions(args: string[]): Set<string> {
  const declared = declaredOptions()
  return new Set(
    typedOptions(args)
      .map((option) => option.name)
      .filter((name) => declared.has(name)),
  )
}

/**
 * A warning for each argument the gateway parsed and will ignore.
 *
 * There is no `.strict()`: yargs takes an option it does not know and carries
 * on, so `--host` before 4.2 or a typo such as `--keepAlive` did nothing, and
 * nobody was told. Refusing them would stop deployments that start today, so
 * the gateway names them instead and carries on as before.
 *
 * yargs files an unknown `--keep-alive` under both `keep-alive` and
 * `keepAlive`, so each is reported once, as typed. Stray positionals are
 * mostly an `--stdio` command that was not quoted: `--stdio npx -y pkg /tmp`
 * runs `npx` and leaves `-y pkg` and `/tmp` behind.
 */
export function unknownArguments(
  args: string[],
  argv: { _: (string | number)[] } & Record<string, unknown>,
): string[] {
  const declared = declaredOptions()
  const typed = typedOptions(args)
  const options = new Set(
    Object.keys(argv)
      .map(canonical)
      .filter((name) => !declared.has(name)),
  )
  const spelling = (name: string) =>
    typed.find((option) => option.name === name)?.spelling ??
    `--${Parser.decamelize(name, '-')}`
  return [
    ...[...options].map(
      (name) => `Ignored unknown option ${spelling(name)} (see --help)`,
    ),
    ...[...new Set(argv._.map(String))].map(
      (arg) =>
        `Ignored unexpected argument ${arg} (an --stdio command with spaces must be quoted)`,
    ),
  ]
}
