#!/usr/bin/env node
/**
 * index.ts
 *
 * Run MCP stdio servers over SSE, convert between stdio, SSE, WS.
 *
 * Usage:
 *   # stdio→SSE
 *   npx -y supergateway --stdio "npx -y @modelcontextprotocol/server-filesystem /" \
 *                       --port 8000 --baseUrl http://localhost:8000 --ssePath /sse --messagePath /message
 *
 *   # SSE→stdio
 *   npx -y supergateway --sse "https://mcp-server-ab71a6b2-cd55-49d0-adba-562bc85956e3.supermachine.app"
 *
 *   # stdio→WS
 *   npx -y supergateway --stdio "npx -y @modelcontextprotocol/server-filesystem /" --outputTransport ws
 *
 *   # Streamable HTTP→stdio
 *   npx -y supergateway --streamableHttp "https://mcp-server.example.com/mcp"
 */

import { readFileSync } from 'node:fs'
import { hideBin } from 'yargs/helpers'
import { stdioToSse, stdioToSseMount } from './gateways/stdioToSse.js'
import { sseToStdio } from './gateways/sseToStdio.js'
import { stdioToWs, stdioToWsMount } from './gateways/stdioToWs.js'
import { streamableHttpToStdio } from './gateways/streamableHttpToStdio.js'
import { headers } from './lib/headers.js'
import { corsOrigin } from './lib/corsOrigin.js'
import { getLogger } from './lib/getLogger.js'
import { apiKeysOf } from './lib/apiKey.js'
import { exitWithProcessOf, watchProcess } from './lib/exitWithProcess.js'
import { requestShutdown } from './lib/onSignals.js'
import {
  stdioToStatelessStreamableHttp,
  stdioToStatelessStreamableHttpMount,
} from './gateways/stdioToStatelessStreamableHttp.js'
import {
  stdioToStatefulStreamableHttp,
  stdioToStatefulStreamableHttpMount,
} from './gateways/stdioToStatefulStreamableHttp.js'
import { routeConflict, serve, type Mount } from './lib/serve.js'
import { announceHost } from './lib/listenHost.js'
import {
  hostOf,
  inputTransportOf,
  parseCli,
  sessionTimeoutOf,
  givenOptions,
  unknownArguments,
  type Cli,
  type InputTransport,
} from './cli.js'
import type { Logger } from './types.js'
import type { ChildCommand } from './lib/childCommand.js'
import { loadConfig, effectiveTransport } from './config/configFile.js'
import {
  cliForEntry,
  configFromCli,
  entryFlagBesideConfig,
  overrideFromCli,
  printableConfig,
} from './config/cliConfig.js'

// What a listening gateway takes beyond the command line, once checked:
// `host` is the address `--host` names, or undefined for every interface, and
// `apiKeys` is empty when no source gives a key, so authentication is off.
type Listening = { host: string | undefined; apiKeys: string[] }

type Start = (argv: Cli, logger: Logger, listening: Listening) => Promise<void>

// A config file can start a server without a shell (`command` + `args`), or
// with its own environment and directory; it puts that here in place of the
// `--stdio` string. See cliForEntry.
const stdioCommand = (argv: Cli) => argv.stdio! as ChildCommand

const unsupported = (
  logger: Logger,
  input: InputTransport,
  output: unknown,
) => {
  logger.error(`Error: ${input}→${output} not supported`)
  process.exit(1)
}

// What a stdio server's gateway takes beyond the port, in either form: alone
// on the port, or mounted at `path` beside others.
type ServerOptions = Listening & { path?: string }

const sseArgs = (
  argv: Cli,
  logger: Logger,
  { host, apiKeys, path }: ServerOptions,
) => ({
  stdioCmd: stdioCommand(argv),
  host,
  path,
  baseUrl: argv.baseUrl,
  ssePath: argv.ssePath,
  messagePath: argv.messagePath,
  logger,
  corsOrigin: corsOrigin({ argv }),
  healthEndpoints: argv.healthEndpoint as string[],
  headers: headers({ argv, logger }),
  apiKeys,
})

const wsArgs = (
  argv: Cli,
  logger: Logger,
  { host, apiKeys, path }: ServerOptions,
) => ({
  stdioCmd: stdioCommand(argv),
  host,
  path,
  messagePath: argv.messagePath,
  logger,
  corsOrigin: corsOrigin({ argv }),
  healthEndpoints: argv.healthEndpoint as string[],
  apiKeys,
})

// Announces the mode and checks the timeout before building the arguments,
// so header diagnostics keep their place in the log.
const streamableHttpArgs = (
  argv: Cli,
  logger: Logger,
  { host, apiKeys, path }: ServerOptions,
) => {
  const shared = () => ({
    stdioCmd: stdioCommand(argv),
    host,
    path,
    streamableHttpPath: argv.streamableHttpPath,
    logger,
    corsOrigin: corsOrigin({ argv }),
    healthEndpoints: argv.healthEndpoint as string[],
    headers: headers({ argv, logger }),
    apiKeys,
  })
  if (!argv.stateful) {
    logger.info('Running stateless server')
    return {
      stateful: false as const,
      args: { ...shared(), protocolVersion: argv.protocolVersion },
    }
  }
  logger.info('Running stateful server')
  const timeout = sessionTimeoutOf(argv)
  if ('error' in timeout) {
    logger.error(timeout.error)
    process.exit(1)
  }
  return {
    stateful: true as const,
    args: { ...shared(), sessionTimeout: timeout.sessionTimeout },
  }
}

/** A stdio server mounted at its path, to share the port with others. */
function mountOf(argv: Cli, logger: Logger, options: ServerOptions): Mount {
  if (argv.outputTransport === 'sse')
    return stdioToSseMount(sseArgs(argv, logger, options))
  if (argv.outputTransport === 'ws')
    return stdioToWsMount(wsArgs(argv, logger, options))
  // The loader gives every entry here a listening output.
  const { stateful, args } = streamableHttpArgs(argv, logger, options)
  return stateful
    ? stdioToStatefulStreamableHttpMount(args)
    : stdioToStatelessStreamableHttpMount(args)
}

// The URLs a server answers, as its command line sets them: none for one on
// stdio, which listens on nothing.
const routesOf = (argv: Cli) =>
  argv.outputTransport === 'stdio'
    ? []
    : [
        ...(argv.outputTransport === 'sse'
          ? [argv.ssePath, argv.messagePath]
          : argv.outputTransport === 'ws'
            ? [argv.messagePath]
            : [argv.streamableHttpPath]),
        ...(argv.healthEndpoint as string[]),
      ]

// How each input transport starts, given the output the command line chose.
const start: Record<InputTransport, Start> = {
  stdio: async (argv, logger, listening) => {
    const { port } = argv
    if (argv.outputTransport === 'sse')
      await stdioToSse({ ...sseArgs(argv, logger, listening), port })
    else if (argv.outputTransport === 'ws')
      await stdioToWs({ ...wsArgs(argv, logger, listening), port })
    else if (argv.outputTransport === 'streamableHttp') {
      const { stateful, args } = streamableHttpArgs(argv, logger, listening)
      if (stateful) await stdioToStatefulStreamableHttp({ ...args, port })
      else await stdioToStatelessStreamableHttp({ ...args, port })
    } else unsupported(logger, 'stdio', argv.outputTransport)
  },
  sse: async (argv, logger) => {
    if (argv.outputTransport === 'stdio')
      await sseToStdio({
        sseUrl: argv.sse!,
        logger,
        headers: headers({ argv, logger }),
      })
    else unsupported(logger, 'sse', argv.outputTransport)
  },
  streamableHttp: async (argv, logger) => {
    if (argv.outputTransport === 'stdio')
      await streamableHttpToStdio({
        streamableHttpUrl: argv.streamableHttp!,
        logger,
        headers: headers({ argv, logger }),
      })
    else unsupported(logger, 'streamableHttp', argv.outputTransport)
  },
}

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

/**
 * The command line to run: the one given, or, with `--config`, the one each
 * of the file's entries is equivalent to, so a file runs through exactly the
 * code a command line does. Exits for `--printConfig`, `--checkConfig` and
 * errors.
 */
function invocation(args: string[], cli: Cli, logger: Logger): Invocation {
  const given = givenOptions(args)
  const print = (value: unknown) => {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
    process.exit(0)
  }
  if (!cli.config) {
    if (cli.checkConfig) {
      logger.error('Error: --checkConfig checks the file given with --config')
      process.exit(1)
    }
    if (cli.printConfig) {
      // As without it: a command line that names no server describes none.
      const chosen = inputTransportOf(cli)
      if ('error' in chosen) {
        logger.error(chosen.error)
        process.exit(1)
      }
      print(printableConfig(configFromCli(cli, given)))
    }
    return { argv: cli, notes: [] }
  }
  const beside = entryFlagBesideConfig(given)
  if (beside !== undefined) {
    logger.error(
      `Error: --${beside} can't be combined with --config. ${besideHint(beside, cli.config)}`,
    )
    process.exit(1)
  }
  let text: string
  try {
    text = readFileSync(cli.config, 'utf8')
  } catch (err) {
    logger.error(`Error: Cannot read ${cli.config}: ${(err as Error).message}`)
    process.exit(1)
  }
  const loaded = loadConfig(cli.config, text, process.env)
  for (const warning of loaded.warnings) logger.error(`Warning: ${warning}`)
  if ('error' in loaded) {
    logger.error(loaded.error)
    process.exit(1)
  }
  const { config, extraKeys, extraKeyFiles, notes } = overrideFromCli(
    loaded.config,
    cli,
    given,
  )
  if (cli.printConfig) print(printableConfig(config))
  const several = config.entries.length > 1
  // Combined entries have no command line of their own (a later 4.2 change).
  const served = config.entries
    .filter((entry) => !('members' in entry.server))
    .map((entry): Served => {
      const run = cliForEntry(config, entry, extraKeys, extraKeyFiles, several)
      const argv = parseCli(run.args)
      if (run.command) argv.stdio = run.command as string
      return { name: entry.name, path: entry.path, argv }
    })
  const healthEndpoints = config.gateway.healthEndpoint ?? []
  const conflict =
    several &&
    routeConflict(
      served.map(({ name, path, argv }) => ({
        name,
        path,
        routes: routesOf(argv),
      })),
      healthEndpoints,
    )
  if (conflict) {
    logger.error(`Error: ${cli.config}: ${conflict}`)
    process.exit(1)
  }
  if (cli.checkConfig) {
    process.stdout.write(
      `${cli.config} is valid: ${config.entries.length} ${config.entries.length === 1 ? 'server' : 'servers'}\n` +
        config.entries
          .map(
            (entry) =>
              `  ${entry.path}  ${entry.name} (${effectiveTransport(entry, config.defaults)})\n`,
          )
          .join(''),
    )
    process.exit(0)
  }
  const notYet = config.entries
    .map((entry) =>
      'members' in entry.server
        ? 'Combining servers on one URL'
        : entry.server.source.kind !== 'url'
          ? undefined
          : effectiveTransport(entry, config.defaults) !== 'stdio'
            ? 'Serving a remote server over HTTP'
            : several
              ? 'Serving an entry over stdio beside others'
              : undefined,
    )
    .find((reason) => reason !== undefined)
  if (notYet) {
    logger.error(
      `Error: ${notYet} is coming in a later 4.2 change; ${cli.config} is valid, but this build can't serve it yet`,
    )
    process.exit(1)
  }
  if (!several) return { argv: served[0].argv, notes }
  return { servers: served, healthEndpoints, notes }
}

async function main() {
  const args = hideBin(process.argv)
  const cli = parseCli(args)
  const cliLogger = getLogger({
    logLevel: cli.logLevel,
    logFormat: cli.logFormat,
    outputTransport: cli.outputTransport as string,
  })
  // Warned, never refused: a refusal would stop deployments that start today.
  for (const warning of unknownArguments(args, cli)) cliLogger.error(warning)
  const run = invocation(args, cli, cliLogger)
  // The gateway-wide settings, which every entry's command line carries alike.
  const argv = 'argv' in run ? run.argv : run.servers[0].argv
  const loggerFor = (server?: string) =>
    getLogger({
      logLevel: argv.logLevel,
      logFormat: argv.logFormat,
      outputTransport: argv.outputTransport as string,
      server,
    })
  const logger = argv === cli ? cliLogger : loggerFor()
  for (const note of run.notes) logger.info(note)
  const chosen = inputTransportOf(argv)
  if ('error' in chosen) {
    logger.error(chosen.error)
    process.exit(1)
  }
  const listen = hostOf(argv)
  if ('error' in listen) {
    logger.error(listen.error)
    process.exit(1)
  }
  // Each server's keys, from its own command line; the environment's, and
  // those given beside --config, are on every one.
  const servers = (
    'servers' in run
      ? run.servers.map((server) => ({
          ...server,
          logger: loggerFor(server.name),
        }))
      : [{ path: '/', argv, logger }]
  ).map((server) => {
    const apiKeys = apiKeysOf(server.argv, process.env, (path) =>
      readFileSync(path, 'utf8'),
    )
    if ('error' in apiKeys) {
      server.logger.error(apiKeys.error)
      process.exit(1)
    }
    return { ...server, apiKeys: apiKeys.keys }
  })
  const watched = exitWithProcessOf(argv)
  if ('error' in watched) {
    logger.error(watched.error)
    process.exit(1)
  }

  logger.info('Starting...')
  logger.info(
    'Supergateway is supported by Supercov - Coverage for coding agents and software factories 🌙 - https://supercov.com',
  )
  if ('servers' in run) {
    logger.info(`  - port: ${argv.port}`)
    announceHost(logger, listen.host)
    logger.info(
      `  - Health endpoints: ${run.healthEndpoints.length ? run.healthEndpoints.join(', ') : '(none)'}`,
    )
  } else logger.info(`  - outputTransport: ${argv.outputTransport}`)
  const { pid } = watched
  if (pid !== undefined) logger.info(`  - exitWithProcess: ${pid}`)

  try {
    if ('servers' in run)
      serve({
        port: argv.port,
        host: listen.host,
        logger,
        mounts: servers.map((server) => {
          server.logger.info(`  - path: ${server.path}`)
          server.logger.info(
            `  - outputTransport: ${server.argv.outputTransport}`,
          )
          return mountOf(server.argv, server.logger, {
            host: listen.host,
            apiKeys: server.apiKeys,
            path: server.path,
          })
        }),
        healthEndpoints: run.healthEndpoints,
      })
    else
      await start[chosen.input](argv, logger, {
        host: listen.host,
        apiKeys: servers[0].apiKeys,
      })
  } catch (err) {
    logger.error('Fatal error:', err)
    process.exit(1)
  }

  // Started only now: the gateway has registered its shutdown, so a launcher
  // that is already gone stops its children rather than skipping them.
  if (pid !== undefined)
    watchProcess(pid, {
      logger,
      onExit: () => requestShutdown(`Process ${pid} exited. Exiting...`),
    })
}

// `main` catches everything it can reach and exits non-zero, so this promise
// cannot reject: the handler that used to sit here could never run. `void`
// records that the floating promise is deliberate.
void main()
