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
 */

import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { Logger } from './types.js'
import { stdioToSse } from './gateways/stdioToSse.js'
import { sseToStdio } from './gateways/sseToStdio.js'
import { stdioToWs } from './gateways/stdioToWs.js'
import { stdioToStatelessStreamableHttp } from './gateways/stdioToStatelessStreamableHttp.js'
import { stdioToStatefulStreamableHttp } from './gateways/stdioToStatefulStreamableHttp.js'
import { streamableHttpToStdio } from './gateways/streamableHttpToStdio.js'
import { headers } from './lib/headers.js'
import { corsOrigin } from './lib/corsOrigin.js'

const log = (...args: any[]) => console.log('[supergateway]', ...args)
const logStderr = (...args: any[]) => console.error('[supergateway]', ...args)

const noneLogger: Logger = {
  info: () => {},
  error: () => {},
}

const getLogger = ({
  logLevel,
  outputTransport,
}: {
  logLevel: string
  outputTransport: string
}): Logger => {
  if (logLevel === 'none') {
    return noneLogger
  }

  if (outputTransport === 'stdio') {
    return { info: logStderr, error: logStderr }
  }

  return { info: log, error: logStderr }
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('stdio', {
      type: 'string',
      description: 'Command to run an MCP server over Stdio',
    })
    .option('sse', {
      type: 'string',
      description: 'SSE URL to connect to',
    })
    .option('streamableHttp', {
      type: 'string',
      description: 'Streamable HTTP URL to connect to',
    })
    .option('outputTransport', {
      type: 'string',
      choices: ['stdio', 'sse', 'ws', 'streamableHttp'],
      default: () => {
        const args = hideBin(process.argv)

        if (args.includes('--stdio')) return 'sse'
        if (args.includes('--sse')) return 'stdio'
        if (args.includes('--streamableHttp')) return 'stdio'

        return undefined
      },
      description:
        'Transport for output. Default is "sse" when using --stdio and "stdio" when using --sse or --streamableHttp.',
    })
    .option('port', {
      type: 'number',
      default: 8000,
      description: '(stdio→SSE, stdio→WS) Port for output MCP server',
    })
    .option('baseUrl', {
      type: 'string',
      default: '',
      description: '(stdio→SSE) Base URL for output MCP server',
    })
    .option('ssePath', {
      type: 'string',
      default: '/sse',
      description: '(stdio→SSE) Path for SSE subscriptions',
    })
    .option('messagePath', {
      type: 'string',
      default: '/message',
      description: '(stdio→SSE, stdio→WS) Path for messages',
    })
    .option('streamableHttpPath', {
      type: 'string',
      default: '/mcp',
      description: '(stdio→StreamableHttp) Path for StreamableHttp endpoint',
    })
    .option('stateful', {
      type: 'boolean',
      default: false,
      description:
        '(stdio→StreamableHttp) Enable stateful mode with persistent sessions',
    })
    .option('protocolVersion', {
      type: 'string',
      default: '2024-11-05',
      description:
        '(stdio→StreamableHttp stateless) MCP protocol version for auto-initialization',
    })
    .option('logLevel', {
      choices: ['info', 'none'] as const,
      default: 'info',
      description: 'Logging level',
    })
    .option('cors', {
      type: 'array',
      description:
        'Enable CORS. Use --cors with no values to allow all origins, or supply one or more allowed origins (e.g. --cors "http://example.com" or --cors "/example\\.com$/" for regex matching).',
    })
    .option('healthEndpoint', {
      type: 'array',
      default: [],
      description:
        'One or more endpoints returning "ok", e.g. --healthEndpoint /healthz --healthEndpoint /readyz',
    })
    .option('header', {
      type: 'array',
      default: [],
      description:
        'Headers to be added to the request headers, e.g. --header "x-user-id: 123"',
    })
    .option('oauth2Bearer', {
      type: 'string',
      description:
        'Authorization header to be added, e.g. --oauth2Bearer "some-access-token" adds "Authorization: Bearer some-access-token"',
    })
    .option('headersPassthrough', {
      type: 'array',
      default: [],
      description:
        '(stdio→StreamableHttp) HTTP request headers to forward as HEADER_<NAME> env vars to the child process, e.g. --headersPassthrough Authorization',
    })
    .help()
    .parseSync()

  const hasStdio = Boolean(argv.stdio)
  const hasSse = Boolean(argv.sse)
  const hasStreamableHttp = Boolean(argv.streamableHttp)

  const activeCount = [hasStdio, hasSse, hasStreamableHttp].filter(
    Boolean,
  ).length

  if (activeCount === 0) {
    logStderr(
      'Error: You must specify one of --stdio, --sse, or --streamableHttp',
    )
    process.exit(1)
  } else if (activeCount > 1) {
    logStderr('Error: Specify only one of --stdio, --sse, or --streamableHttp')
    process.exit(1)
  }

  const logger = getLogger({
    logLevel: argv.logLevel,
    outputTransport: argv.outputTransport as string,
  })

  logger.info('Starting...')
  logger.info(
    'Supergateway is supported by Supermachine (hosted MCPs) - https://supermachine.ai',
  )
  logger.info(`  - outputTransport: ${argv.outputTransport}`)

  try {
    if (hasStdio) {
      if (argv.outputTransport === 'sse') {
        await stdioToSse({
          stdioCmd: argv.stdio!,
          port: argv.port,
          baseUrl: argv.baseUrl,
          ssePath: argv.ssePath,
          messagePath: argv.messagePath,
          logger,
          corsOrigin: corsOrigin({ argv }),
          healthEndpoints: argv.healthEndpoint as string[],
          headers: headers({
            argv,
            logger,
          }),
        })
      } else if (argv.outputTransport === 'ws') {
        await stdioToWs({
          stdioCmd: argv.stdio!,
          port: argv.port,
          messagePath: argv.messagePath,
          logger,
          corsOrigin: corsOrigin({ argv }),
          healthEndpoints: argv.healthEndpoint as string[],
        })
      } else if (argv.outputTransport === 'streamableHttp') {
        if (argv.stateful) {
          logger.info('Running stateful StreamableHttp server')
          await stdioToStatefulStreamableHttp({
            stdioCmd: argv.stdio!,
            port: argv.port,
            streamableHttpPath: argv.streamableHttpPath,
            logger,
            corsOrigin: corsOrigin({ argv }),
            healthEndpoints: argv.healthEndpoint as string[],
            headers: headers({ argv, logger }),
            headersPassthrough: argv.headersPassthrough as string[],
          })
        } else {
          logger.info('Running stateless StreamableHttp server')
          await stdioToStatelessStreamableHttp({
            stdioCmd: argv.stdio!,
            port: argv.port,
            streamableHttpPath: argv.streamableHttpPath,
            logger,
            corsOrigin: corsOrigin({ argv }),
            healthEndpoints: argv.healthEndpoint as string[],
            headers: headers({ argv, logger }),
            protocolVersion: argv.protocolVersion,
            headersPassthrough: argv.headersPassthrough as string[],
          })
        }
      } else {
        logStderr(`Error: stdio→${argv.outputTransport} not supported`)
        process.exit(1)
      }
    } else if (hasSse) {
      if (argv.outputTransport === 'stdio') {
        await sseToStdio({
          sseUrl: argv.sse!,
          logger,
          headers: headers({
            argv,
            logger,
          }),
        })
      } else {
        logStderr(`Error: sse→${argv.outputTransport} not supported`)
        process.exit(1)
      }
    } else if (hasStreamableHttp) {
      if (argv.outputTransport === 'stdio') {
        await streamableHttpToStdio({
          streamableHttpUrl: argv.streamableHttp!,
          logger,
          headers: headers({ argv, logger }),
        })
      } else {
        logStderr(`Error: streamableHttp→${argv.outputTransport} not supported`)
        process.exit(1)
      }
    } else {
      logStderr('Error: Invalid input transport')
      process.exit(1)
    }
  } catch (err) {
    logStderr('Fatal error:', err)
    process.exit(1)
  }
}

main()
