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
import type { ServerSource } from './lib/serverSource.js'
import { parseUpstreamUrl } from './lib/urlCredentials.js'
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

// The server a listening gateway serves: the --stdio command, or the --sse
// or --streamableHttp server, with --header and --oauth2Bearer as what the
// gateway sends it.
const serverOf = (argv: Cli, logger: Logger): ServerSource => {
  const url = argv.sse ?? argv.streamableHttp
  if (url === undefined) return { stdioCmd: stdioCommand(argv) }
  return {
    upstream: {
      url: parseUpstreamUrl(url),
      type: argv.sse ? 'sse' : 'streamableHttp',
      headers: headers({ argv, logger }),
    },
  }
}

// What the gateway's own responses carry: --header for a local server. For a
// remote one, --header is what the gateway sends it; returning that to every
// client could hand them the remote server's credentials.
const responseHeaders = (source: ServerSource, argv: Cli, logger: Logger) =>
  source.upstream ? {} : headers({ argv, logger })

const sseArgs = (
  argv: Cli,
  logger: Logger,
  { host, apiKeys, path }: ServerOptions,
) => {
  const source = serverOf(argv, logger)
  return {
    ...source,
    host,
    path,
    baseUrl: argv.baseUrl,
    ssePath: argv.ssePath,
    messagePath: argv.messagePath,
    logger,
    corsOrigin: corsOrigin({ argv }),
    healthEndpoints: argv.healthEndpoint as string[],
    headers: responseHeaders(source, argv, logger),
    apiKeys,
  }
}

const wsArgs = (
  argv: Cli,
  logger: Logger,
  { host, apiKeys, path }: ServerOptions,
) => ({
  ...serverOf(argv, logger),
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
  const shared = () => {
    const source = serverOf(argv, logger)
    return {
      ...source,
      host,
      path,
      streamableHttpPath: argv.streamableHttpPath,
      logger,
      corsOrigin: corsOrigin({ argv }),
      healthEndpoints: argv.healthEndpoint as string[],
      headers: responseHeaders(source, argv, logger),
      apiKeys,
    }
  }
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

// A server served over HTTP or WebSocket, alone on the port. The command
// line only allows the four outputs, and stdio is a bridge or refused.
const listen = async (argv: Cli, logger: Logger, listening: Listening) => {
  const { port } = argv
  if (argv.outputTransport === 'sse')
    await stdioToSse({ ...sseArgs(argv, logger, listening), port })
  else if (argv.outputTransport === 'ws')
    await stdioToWs({ ...wsArgs(argv, logger, listening), port })
  else {
    const { stateful, args } = streamableHttpArgs(argv, logger, listening)
    if (stateful) await stdioToStatefulStreamableHttp({ ...args, port })
    else await stdioToStatelessStreamableHttp({ ...args, port })
  }
}

// How each input transport starts, given the output the command line chose.
// A remote server on stdio is a bridge; on any other output, it is served
// the way a local one is.
const start: Record<InputTransport, Start> = {
  stdio: async (argv, logger, listening) => {
    if (argv.outputTransport === 'stdio')
      unsupported(logger, 'stdio', argv.outputTransport)
    else await listen(argv, logger, listening)
  },
  sse: async (argv, logger, listening) => {
    if (argv.outputTransport === 'stdio')
      await sseToStdio({
        sseUrl: argv.sse!,
        logger,
        headers: headers({ argv, logger }),
      })
    else await listen(argv, logger, listening)
  },
  streamableHttp: async (argv, logger, listening) => {
    if (argv.outputTransport === 'stdio')
      await streamableHttpToStdio({
        streamableHttpUrl: argv.streamableHttp!,
        logger,
        headers: headers({ argv, logger }),
      })
    else await listen(argv, logger, listening)
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
        : // Only a remote server can be on stdio: the loader refuses a local one.
          several && effectiveTransport(entry, config.defaults) === 'stdio'
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

// What a startup check found, or, when it found a problem, exit 1 after
// logging it.
function orExit<T extends object>(
  logger: Logger,
  result: T | { error: string },
): T {
  if ('error' in result) {
    logger.error(result.error)
    process.exit(1)
  }
  return result as T
}

// Each server's keys, from its own command line; the environment's, and
// those given beside --config, are on every one.
function keyedServers(
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
      : [{ path: '/', argv, logger }]
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
function announceStart(
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

// Several config entries, each mounted at its path, on one port.
function serveSeveral(
  servers: ReturnType<typeof keyedServers>,
  healthEndpoints: string[],
  port: number,
  host: string | undefined,
  logger: Logger,
) {
  serve({
    port,
    host,
    logger,
    mounts: servers.map((server) => {
      server.logger.info(`  - path: ${server.path}`)
      server.logger.info(`  - outputTransport: ${server.argv.outputTransport}`)
      return mountOf(server.argv, server.logger, {
        host,
        apiKeys: server.apiKeys,
        path: server.path,
      })
    }),
    healthEndpoints,
  })
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
  const { input } = orExit(logger, inputTransportOf(argv))
  const { host } = orExit(logger, hostOf(argv))
  const servers = keyedServers(run, argv, logger, loggerFor)
  const { pid } = orExit(logger, exitWithProcessOf(argv))
  announceStart(logger, run, argv, host, pid)

  try {
    if ('servers' in run)
      serveSeveral(servers, run.healthEndpoints, argv.port, host, logger)
    else
      await start[input](argv, logger, {
        host,
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
