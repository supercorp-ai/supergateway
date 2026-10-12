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

import { hideBin } from 'yargs/helpers'
import { parseCli, unknownArguments, inputTransportOf, hostOf } from './cli.js'
import { getLogger } from './lib/getLogger.js'
import { invocation, keyedServers, announceStart } from './invocation.js'
import { isOnStdio, serveSeveral } from './startSeveral.js'
import { orExit } from './exits.js'
import { exitWithProcessOf, watchProcess } from './lib/exitWithProcess.js'
import { start } from './startOne.js'
import { requestShutdown } from './lib/onSignals.js'

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
