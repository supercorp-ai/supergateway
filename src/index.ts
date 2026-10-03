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
import type { BridgeLifecycle } from './lib/stdioBridge.js'
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
import type { HealthCheck } from './lib/serverHealth.js'
import { ToolNames } from './lib/toolNames.js'
import {
  loadConfig,
  effectiveTransport,
  type Config,
  type EndpointOptions,
  type Entry,
} from './config/configFile.js'
import {
  cliForEntry,
  type MemberServer,
  configFromCli,
  entryFlagBesideConfig,
  overrideFromCli,
  printableConfig,
} from './config/cliConfig.js'

// What a listening gateway takes beyond the command line, once checked:
// `host` is the address `--host` names, or undefined for every interface, and
// `apiKeys` is empty when no source gives a key, so authentication is off.
type Listening = { host: string | undefined; apiKeys: string[] }

// A config file can start a server without a shell (`command` + `args`), or
// with its own environment and directory; it puts that here in place of the
// `--stdio` string. See cliForEntry.
const stdioCommand = (argv: Cli) => argv.stdio! as ChildCommand

// Startup ends here: the problem is logged, and the gateway exits 1.
function exitWithError(logger: Logger, message: string): never {
  logger.error(message)
  process.exit(1)
}

// What a startup check found, or, when it found a problem, exit 1 after
// logging it.
function orExit<T extends object>(
  logger: Logger,
  result: T | { error: string },
): T {
  if ('error' in result) exitWithError(logger, result.error)
  return result as T
}

const unsupported = (logger: Logger, input: InputTransport, output: unknown) =>
  exitWithError(logger, `Error: ${input}→${output} not supported`)

// What a stdio server's gateway takes beyond the port, in either form: alone
// on the port, or mounted at `path` beside others.
type ServerOptions = Listening & { path?: string }

// The server a listening gateway serves: the --stdio command, or the --sse
// or --streamableHttp server, with --header and --oauth2Bearer as what the
// gateway sends it.
const serverOf = (argv: Cli, logger: Logger): ServerSource => {
  const url = argv.sse ?? argv.streamableHttp
  const toolNames = toolNamesOf(argv, logger)
  // A combined entry's servers, which no command line can name.
  const members = argv.combined as MemberServer[] | undefined
  if (members)
    return {
      combined: {
        name: argv.stdio!,
        members: members.map((member) => memberSource(member, logger)),
      },
      toolNames,
    }
  if (url === undefined) return { stdioCmd: stdioCommand(argv), toolNames }
  return {
    upstream: {
      url: parseUpstreamUrl(url),
      type: argv.sse ? 'sse' : 'streamableHttp',
      headers: headers({ argv, logger }),
    },
    toolNames,
  }
}

// One of a combined entry's servers: local or remote, with its own tools.
const memberSource = (
  { name, command, upstream, toolPrefix, tools }: MemberServer,
  logger: Logger,
): ServerSource & { name: string } => {
  const toolNames = ToolNames.of({ toolPrefix, tools }, logger)
  return upstream
    ? {
        name,
        upstream: { ...upstream, url: parseUpstreamUrl(upstream.url) },
        toolNames,
      }
    : // The loader gives a server a command or a url.
      { name, stdioCmd: command!, toolNames }
}

// The tools a client sees of the server: none rewritten unless --toolPrefix
// or --tools is given.
const toolNamesOf = (argv: Cli, logger: Logger) =>
  ToolNames.of(
    { toolPrefix: argv.toolPrefix, tools: argv.tools as string[] | undefined },
    logger,
  )

// What the gateway's own responses carry: --header for a local server. For a
// remote one, --header is what the gateway sends it; returning that to every
// client could hand them the remote server's credentials.
const responseHeaders = (source: ServerSource, argv: Cli, logger: Logger) =>
  source.upstream ? {} : headers({ argv, logger })

// What every listening gateway takes, whichever output it serves. `source`
// is kept apart, so a gateway that answers with headers can tell whether its
// server is remote.
const listenerArgs = (
  argv: Cli,
  logger: Logger,
  { host, apiKeys, path }: ServerOptions,
) => {
  const source = serverOf(argv, logger)
  return {
    source,
    shared: {
      ...source,
      host,
      path,
      logger,
      corsOrigin: corsOrigin({ argv }),
      healthEndpoints: argv.healthEndpoint as string[],
      healthCheck: argv.healthCheck as HealthCheck,
      apiKeys,
    },
  }
}

const sseArgs = (argv: Cli, logger: Logger, options: ServerOptions) => {
  const { source, shared } = listenerArgs(argv, logger, options)
  return {
    ...shared,
    baseUrl: argv.baseUrl,
    ssePath: argv.ssePath,
    messagePath: argv.messagePath,
    headers: responseHeaders(source, argv, logger),
  }
}

const wsArgs = (argv: Cli, logger: Logger, options: ServerOptions) => ({
  ...listenerArgs(argv, logger, options).shared,
  messagePath: argv.messagePath,
})

// Announces the mode and checks the timeout before building the arguments,
// so header diagnostics keep their place in the log.
const streamableHttpArgs = (
  argv: Cli,
  logger: Logger,
  options: ServerOptions,
) => {
  const common = () => {
    const { source, shared } = listenerArgs(argv, logger, options)
    return {
      ...shared,
      streamableHttpPath: argv.streamableHttpPath,
      headers: responseHeaders(source, argv, logger),
    }
  }
  if (!argv.stateful) {
    logger.info('Running stateless server')
    return {
      stateful: false as const,
      args: { ...common(), protocolVersion: argv.protocolVersion },
    }
  }
  logger.info('Running stateful server')
  const { sessionTimeout } = orExit(logger, sessionTimeoutOf(argv))
  return {
    stateful: true as const,
    args: { ...common(), sessionTimeout },
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

// A remote server bridged to stdio output.
const bridge = {
  sse: (argv: Cli, logger: Logger, lifecycle?: BridgeLifecycle) =>
    sseToStdio({
      sseUrl: argv.sse!,
      logger,
      headers: headers({ argv, logger }),
      toolNames: toolNamesOf(argv, logger),
      lifecycle,
    }),
  streamableHttp: (argv: Cli, logger: Logger, lifecycle?: BridgeLifecycle) =>
    streamableHttpToStdio({
      streamableHttpUrl: argv.streamableHttp!,
      logger,
      headers: headers({ argv, logger }),
      toolNames: toolNamesOf(argv, logger),
      lifecycle,
    }),
}

// How a server alone on the port starts, given the output the command line
// chose. A remote server on stdio is a bridge; on any other output, it is
// served the way a local one is. A local server already speaks stdio.
async function start(
  input: InputTransport,
  argv: Cli,
  logger: Logger,
  listening: Listening,
) {
  if (argv.outputTransport !== 'stdio') await listen(argv, logger, listening)
  else if (input === 'stdio') unsupported(logger, input, argv.outputTransport)
  else await bridge[input](argv, logger)
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

// `--printConfig`'s output, after which the gateway exits.
function printAndExit(value: unknown): never {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  process.exit(0)
}

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

// What a valid config asks for that this build can't serve yet, if anything.
const notYetServable = (config: Config) =>
  config.entries.some(
    (entry) =>
      'members' in entry.server &&
      effectiveTransport(entry, config.defaults) === 'stdio',
  )
    ? 'Serving combined servers over stdio'
    : undefined

/**
 * The command line to run: the one given, or, with `--config`, the one each
 * of the file's entries is equivalent to, so a file runs through exactly the
 * code a command line does. Exits for `--printConfig`, `--checkConfig` and
 * errors.
 */
function invocation(args: string[], cli: Cli, logger: Logger): Invocation {
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
  const notYet = notYetServable(config)
  if (notYet)
    exitWithError(
      logger,
      `Error: ${notYet} is coming in a later 4.2 change; ${file} is valid, but this build can't serve it yet`,
    )
  if (!several) return { argv: served[0].argv, notes }
  return { servers: served, healthEndpoints, notes }
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

type KeyedServer = ReturnType<typeof keyedServers>[number]

// Several config entries, each mounted at its path, on one port, and at most
// one on stdio beside them (the loader allows no more).
async function serveSeveral(
  servers: KeyedServer[],
  healthEndpoints: string[],
  port: number,
  host: string | undefined,
  logger: Logger,
) {
  const onStdio = servers.find(isOnStdio)
  let closeStdio: (() => Promise<void>) | undefined
  serve({
    port,
    host,
    logger,
    mounts: servers
      .filter((server) => server !== onStdio)
      .map((server) => {
        server.logger.info(`  - path: ${server.path}`)
        server.logger.info(
          `  - outputTransport: ${server.argv.outputTransport}`,
        )
        return mountOf(server.argv, server.logger, {
          host,
          apiKeys: server.apiKeys,
          path: server.path,
        })
      }),
    healthEndpoints,
    stdio: onStdio && { close: async () => closeStdio?.() },
  })
  if (onStdio)
    await bridgeBeside(onStdio, (cleanup) => {
      closeStdio = cleanup
    })
}

const isOnStdio = (server: { argv: Cli }) =>
  server.argv.outputTransport === 'stdio'

// The remote server on stdio beside the others. The process is its client's,
// which started it: when the bridge stops, the others stop too, as at a
// signal, and the signals stop the bridge with them.
async function bridgeBeside(
  server: KeyedServer,
  register: BridgeLifecycle['register'],
) {
  server.logger.info('  - outputTransport: stdio')
  // The loader allows only a remote server on stdio.
  const { input } = orExit(server.logger, inputTransportOf(server.argv))
  await bridge[input as keyof typeof bridge](server.argv, server.logger, {
    register,
    exit: (code) =>
      requestShutdown(`${server.name} on stdio stopped. Exiting...`, code),
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
  // No log line goes to stdout while it carries an entry's MCP messages.
  const logsBesideStdio = 'servers' in run && run.servers.some(isOnStdio)
  const loggerFor = (server?: string) =>
    getLogger({
      logLevel: argv.logLevel,
      logFormat: argv.logFormat,
      outputTransport: logsBesideStdio
        ? 'stdio'
        : (argv.outputTransport as string),
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
      await serveSeveral(servers, run.healthEndpoints, argv.port, host, logger)
    else
      await start(input, argv, logger, {
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
