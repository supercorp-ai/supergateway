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
import { stdioToSse } from './gateways/stdioToSse.js'
import { sseToStdio } from './gateways/sseToStdio.js'
import { stdioToWs } from './gateways/stdioToWs.js'
import { streamableHttpToStdio } from './gateways/streamableHttpToStdio.js'
import { headers } from './lib/headers.js'
import { corsOrigin } from './lib/corsOrigin.js'
import { getLogger } from './lib/getLogger.js'
import { stdioToStatelessStreamableHttp } from './gateways/stdioToStatelessStreamableHttp.js'
import { stdioToStatefulStreamableHttp } from './gateways/stdioToStatefulStreamableHttp.js'
import {
  inputTransportOf,
  parseCli,
  sessionTimeoutOf,
  type Cli,
  type InputTransport,
} from './cli.js'
import type { Logger } from './types.js'

type Start = (argv: Cli, logger: Logger) => Promise<void>

const unsupported = (
  logger: Logger,
  input: InputTransport,
  output: unknown,
) => {
  logger.error(`Error: ${input}→${output} not supported`)
  process.exit(1)
}

const stdioToStreamableHttp: Start = async (argv, logger) => {
  // Built when the gateway starts, after the mode is announced and the
  // timeout checked, so header diagnostics keep their place in the log.
  const shared = () => ({
    stdioCmd: argv.stdio!,
    port: argv.port,
    streamableHttpPath: argv.streamableHttpPath,
    logger,
    corsOrigin: corsOrigin({ argv }),
    healthEndpoints: argv.healthEndpoint as string[],
    headers: headers({ argv, logger }),
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
  stdio: async (argv, logger) => {
    if (argv.outputTransport === 'sse')
      await stdioToSse({
        stdioCmd: argv.stdio!,
        port: argv.port,
        baseUrl: argv.baseUrl,
        ssePath: argv.ssePath,
        messagePath: argv.messagePath,
        logger,
        corsOrigin: corsOrigin({ argv }),
        healthEndpoints: argv.healthEndpoint as string[],
        headers: headers({ argv, logger }),
      })
    else if (argv.outputTransport === 'ws')
      await stdioToWs({
        stdioCmd: argv.stdio!,
        port: argv.port,
        messagePath: argv.messagePath,
        logger,
        corsOrigin: corsOrigin({ argv }),
        healthEndpoints: argv.healthEndpoint as string[],
      })
    else if (argv.outputTransport === 'streamableHttp')
      await stdioToStreamableHttp(argv, logger)
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

async function main() {
  const argv = parseCli(hideBin(process.argv))
  const logger = getLogger({
    logLevel: argv.logLevel,
    outputTransport: argv.outputTransport as string,
  })
  const chosen = inputTransportOf(argv)
  if ('error' in chosen) {
    logger.error(chosen.error)
    process.exit(1)
  }

  logger.info('Starting...')
  logger.info(
    'Supergateway is supported by Supercov - Coverage for coding agents and software factories 🌙 - https://supercov.com',
  )
  logger.info(`  - outputTransport: ${argv.outputTransport}`)

  try {
    await start[chosen.input](argv, logger)
  } catch (err) {
    logger.error('Fatal error:', err)
    process.exit(1)
  }
}

// `main` catches everything it can reach and exits non-zero, so this promise
// cannot reject: the handler that used to sit here could never run. `void`
// records that the floating promise is deliberate.
void main()
