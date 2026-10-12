import { type Cli, inputTransportOf, parseCli, givenOptions } from './cli.js'
import type { Logger } from './types.js'
import { exitWithError, orExit, printAndExit } from './exits.js'
import {
  printableConfig,
  configFromCli,
  overrideFromCli,
  cliForEntry,
  entryFlagBesideConfig,
} from './config/cliConfig.js'
import {
  type Config,
  loadConfig,
  effectiveTransport,
} from './config/configFile.js'
import { readFileSync } from 'node:fs'
import { routeConflict } from './lib/serve.js'
import { apiKeysOf } from './lib/apiKey.js'
import { announceHost } from './lib/listenHost.js'

// The URLs each listening output answers, beside its health endpoints.
const outputRoutes: Record<string, (argv: Cli) => string[]> = {
  sse: (argv) => [argv.ssePath, argv.messagePath],
  ws: (argv) => [argv.messagePath],
  streamableHttp: (argv) => [argv.streamableHttpPath],
}

// The URLs a server answers, as its command line sets them: none for one on
// stdio, which listens on nothing.
const routesOf = (argv: Cli) =>
  argv.outputTransport === 'stdio'
    ? []
    : [
        ...outputRoutes[argv.outputTransport!](argv),
        ...(argv.healthEndpoint as string[]),
      ]

// Where a flag refused beside --config belongs in the file.
function besideHint(flag: string, file: string) {
  if (flag === 'stdio')
    return `Put the server under "mcpServers" in ${file}, with "command" and "args", or "stdio"`
  if (flag === 'sse' || flag === 'streamableHttp')
    return `Put the server under "mcpServers" in ${file}, with "url" and "type": "${flag}"`
  return `Set "${flag === 'header' ? 'headers' : flag}" in ${file}, on a server or at the top level`
}

// One entry of several served on one port: its command line, as cliForEntry
// gives it, and where its requests start.
type Served = { name: string; path: string; argv: Cli }

type Invocation =
  | { argv: Cli; notes: string[] }
  | { servers: Served[]; healthEndpoints: string[]; notes: string[] }

// A command line without `--config` runs as given; `--printConfig` prints the
// config it is equivalent to.
function withoutConfig(cli: Cli, given: Set<string>, logger: Logger) {
  if (cli.checkConfig)
    exitWithError(
      logger,
      'Error: --checkConfig checks the file given with --config',
    )
  if (cli.printConfig) {
    // As without it: a command line that names no server describes none.
    orExit(logger, inputTransportOf(cli))
    printAndExit(printableConfig(configFromCli(cli, given)))
  }
  return { argv: cli, notes: [] }
}

// The file `--config` names, read and checked. Its warnings are logged
// whether or not it holds an error.
function readConfigFile(file: string, logger: Logger): Config {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    exitWithError(
      logger,
      `Error: Cannot read ${file}: ${(err as Error).message}`,
    )
  }
  const loaded = loadConfig(file, text, process.env)
  for (const warning of loaded.warnings) logger.error(`Warning: ${warning}`)
  return orExit<{ config: Config }>(logger, loaded).config
}

// The command line each entry is equivalent to. A combined entry's selects
// the mode and its settings; its servers ride along, as a command does.
function servedEntries(
  { config, extraKeys, extraKeyFiles }: ReturnType<typeof overrideFromCli>,
  several: boolean,
) {
  return config.entries.map((entry): Served => {
    const run = cliForEntry(config, entry, extraKeys, extraKeyFiles, several)
    const argv = parseCli(run.args)
    if (run.command) argv.stdio = run.command as string
    if (run.members) argv.combined = run.members
    return { name: entry.name, path: entry.path, argv }
  })
}

// `--checkConfig`'s report: each entry with its path and output transport.
function reportValid(file: string, config: Config): never {
  const count = config.entries.length
  process.stdout.write(
    `${file} is valid: ${count} ${count === 1 ? 'server' : 'servers'}\n` +
      config.entries
        .map(
          (entry) =>
            `  ${entry.path}  ${entry.name} (${effectiveTransport(entry, config.defaults)})\n`,
        )
        .join(''),
  )
  process.exit(0)
}

// Why several entries can't share the port as configured, if they can't.
const sharedPortConflict = (served: Served[], healthEndpoints: string[]) =>
  routeConflict(
    served.map(({ name, path, argv }) => ({
      name,
      path,
      routes: routesOf(argv),
    })),
    healthEndpoints,
  )

/**
 * The command line to run: the one given, or, with `--config`, the one each
 * of the file's entries is equivalent to, so a file runs through exactly the
 * code a command line does. Exits for `--printConfig`, `--checkConfig` and
 * errors.
 */
export function invocation(
  args: string[],
  cli: Cli,
  logger: Logger,
): Invocation {
  const given = givenOptions(args)
  if (!cli.config) return withoutConfig(cli, given, logger)
  const file = cli.config
  const beside = entryFlagBesideConfig(given)
  if (beside !== undefined)
    exitWithError(
      logger,
      `Error: --${beside} can't be combined with --config. ${besideHint(beside, file)}`,
    )
  const overridden = overrideFromCli(readConfigFile(file, logger), cli, given)
  const { config, notes } = overridden
  if (cli.printConfig) printAndExit(printableConfig(config))
  const several = config.entries.length > 1
  const served = servedEntries(overridden, several)
  const healthEndpoints = config.gateway.healthEndpoint ?? []
  const conflict = several && sharedPortConflict(served, healthEndpoints)
  if (conflict) exitWithError(logger, `Error: ${file}: ${conflict}`)
  if (cli.checkConfig) reportValid(file, config)
  if (!several) return { argv: served[0].argv, notes }
  return { servers: served, healthEndpoints, notes }
}

// Each server's keys, from its own command line; the environment's, and
// those given beside --config, are on every one.
export function keyedServers(
  run: Invocation,
  argv: Cli,
  logger: Logger,
  loggerFor: (server: string) => Logger,
) {
  const servers =
    'servers' in run
      ? run.servers.map((server) => ({
          ...server,
          logger: loggerFor(server.name),
        }))
      : [{ name: 'default', path: '/', argv, logger }]
  return servers.map((server) => ({
    ...server,
    apiKeys: orExit(
      server.logger,
      apiKeysOf(server.argv, process.env, (path) => readFileSync(path, 'utf8')),
    ).keys,
  }))
}

// The gateway's own lines of the startup listing. Several servers on one port
// list the port, host and health endpoints they share; a server alone lists
// them with its own settings.
export function announceStart(
  logger: Logger,
  run: Invocation,
  argv: Cli,
  host: string | undefined,
  pid: number | undefined,
) {
  logger.info('Starting...')
  logger.info(
    'Supergateway is supported by Supercov - Coverage for coding agents and software factories 🌙 - https://supercov.com',
  )
  if ('servers' in run) {
    logger.info(`  - port: ${argv.port}`)
    announceHost(logger, host)
    logger.info(
      `  - Health endpoints: ${run.healthEndpoints.length ? run.healthEndpoints.join(', ') : '(none)'}`,
    )
  } else logger.info(`  - outputTransport: ${argv.outputTransport}`)
  if (pid !== undefined) logger.info(`  - exitWithProcess: ${pid}`)
}

export type KeyedServer = ReturnType<typeof keyedServers>[number]
