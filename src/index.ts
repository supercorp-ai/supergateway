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
import { stdioToSse } from './gateways/stdioToSse.js'
import { sseToStdio } from './gateways/sseToStdio.js'
import { stdioToWs } from './gateways/stdioToWs.js'
import { streamableHttpToStdio } from './gateways/streamableHttpToStdio.js'
import { headers } from './lib/headers.js'
import { corsOrigin } from './lib/corsOrigin.js'
import { getLogger } from './lib/getLogger.js'
import { apiKeysOf } from './lib/apiKey.js'
import { exitWithProcessOf, watchProcess } from './lib/exitWithProcess.js'
import { requestShutdown } from './lib/onSignals.js'
import { stdioToStatelessStreamableHttp } from './gateways/stdioToStatelessStreamableHttp.js'
import { stdioToStatefulStreamableHttp } from './gateways/stdioToStatefulStreamableHttp.js'
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

const stdioToStreamableHttp: Start = async (
  argv,
  logger,
  { host, apiKeys },
) => {
  // Built when the gateway starts, after the mode is announced and the
  // timeout checked, so header diagnostics keep their place in the log.
  const shared = () => ({
    stdioCmd: stdioCommand(argv),
    port: argv.port,
    host,
    streamableHttpPath: argv.streamableHttpPath,
    logger,
    corsOrigin: corsOrigin({ argv }),
    healthEndpoints: argv.healthEndpoint as string[],
    headers: headers({ argv, logger }),
    apiKeys,
  })
  if (!argv.stateful) {
    logger.info('Running stateless server')
    await stdioToStatelessStreamableHttp({
      ...shared(),
      protocolVersion: argv.protocolVersion,
    })
    return
  }
  logger.info('Running stateful server')
  const timeout = sessionTimeoutOf(argv)
  if ('error' in timeout) {
    logger.error(timeout.error)
    process.exit(1)
  }
  await stdioToStatefulStreamableHttp({
    ...shared(),
    sessionTimeout: timeout.sessionTimeout,
  })
}

// How each input transport starts, given the output the command line chose.
const start: Record<InputTransport, Start> = {
  stdio: async (argv, logger, listening) => {
    const { host, apiKeys } = listening
    if (argv.outputTransport === 'sse')
      await stdioToSse({
        stdioCmd: stdioCommand(argv),
        port: argv.port,
        host,
        baseUrl: argv.baseUrl,
        ssePath: argv.ssePath,
        messagePath: argv.messagePath,
        logger,
        corsOrigin: corsOrigin({ argv }),
        healthEndpoints: argv.healthEndpoint as string[],
        headers: headers({ argv, logger }),
        apiKeys,
      })
    else if (argv.outputTransport === 'ws')
      await stdioToWs({
        stdioCmd: stdioCommand(argv),
        port: argv.port,
        host,
        messagePath: argv.messagePath,
        logger,
        corsOrigin: corsOrigin({ argv }),
        healthEndpoints: argv.healthEndpoint as string[],
        apiKeys,
      })
    else if (argv.outputTransport === 'streamableHttp')
      await stdioToStreamableHttp(argv, logger, listening)
    else unsupported(logger, 'stdio', argv.outputTransport)
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

/**
 * The command line to run: the one given, or, with `--config`, the one the
 * file's entry is equivalent to, so a file runs through exactly the code a
 * command line does. Exits for `--printConfig`, `--checkConfig` and errors.
 */
function invocation(args: string[], cli: Cli, logger: Logger) {
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
  const [entry, second] = config.entries
  const notYet =
    second !== undefined
      ? 'Several servers on one port'
      : 'members' in entry.server
        ? 'Combining servers on one URL'
        : entry.server.source.kind === 'url' &&
            effectiveTransport(entry, config.defaults) !== 'stdio'
          ? 'Serving a remote server over HTTP'
          : undefined
  if (notYet) {
    logger.error(
      `Error: ${notYet} is coming in a later 4.2 change; ${cli.config} is valid, but this build runs one server per file`,
    )
    process.exit(1)
  }
  const run = cliForEntry(config, entry, extraKeys, extraKeyFiles)
  const argv = parseCli(run.args)
  if (run.command) argv.stdio = run.command as string
  return { argv, notes }
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
  const { argv, notes } = invocation(args, cli, cliLogger)
  const logger =
    argv === cli
      ? cliLogger
      : getLogger({
          logLevel: argv.logLevel,
          logFormat: argv.logFormat,
          outputTransport: argv.outputTransport as string,
        })
  for (const note of notes) logger.info(note)
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
  const apiKeys = apiKeysOf(argv, process.env, (path) =>
    readFileSync(path, 'utf8'),
  )
  if ('error' in apiKeys) {
    logger.error(apiKeys.error)
    process.exit(1)
  }
  const watched = exitWithProcessOf(argv)
  if ('error' in watched) {
    logger.error(watched.error)
    process.exit(1)
  }

  logger.info('Starting...')
  logger.info(
    'Supergateway is supported by Supercov - Coverage for coding agents and software factories 🌙 - https://supercov.com',
  )
  logger.info(`  - outputTransport: ${argv.outputTransport}`)
  const { pid } = watched
  if (pid !== undefined) logger.info(`  - exitWithProcess: ${pid}`)

  try {
    await start[chosen.input](argv, logger, {
      host: listen.host,
      apiKeys: apiKeys.keys,
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
