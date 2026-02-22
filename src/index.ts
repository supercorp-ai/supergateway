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

import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { readFile } from 'node:fs/promises'
import { stdioToSse, multiStdioToSse } from './gateways/stdioToSse.js'
import { sseToStdio } from './gateways/sseToStdio.js'
import { stdioToWs, multiStdioToWs } from './gateways/stdioToWs.js'
import { streamableHttpToStdio } from './gateways/streamableHttpToStdio.js'
import { headers } from './lib/headers.js'
import { corsOrigin } from './lib/corsOrigin.js'
import { getLogger } from './lib/getLogger.js'
import { stdioToStatelessStreamableHttp } from './gateways/stdioToStatelessStreamableHttp.js'
import { multiStdioToStatelessStreamableHttp } from './gateways/stdioToStatelessStreamableHttp.js'
import {
  stdioToStatefulStreamableHttp,
  multiStdioToStatefulStreamableHttp,
} from './gateways/stdioToStatefulStreamableHttp.js'
import express from 'express'

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('stdio', {
      type: 'string',
      array: true,
      description:
        'Command to run an MCP server over Stdio. Can be provided multiple times as name=command for multi-server mode.',
    })
    .option('sse', {
      type: 'string',
      description: 'SSE URL to connect to',
    })
    .option('streamableHttp', {
      type: 'string',
      description: 'Streamable HTTP URL to connect to',
    })
    .option('multiServerConfig', {
      type: 'string',
      description:
        'Path to a JSON file defining multiple stdio-backed servers served on different paths.',
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
      description: '(stdio→StreamableHttp) Path for StreamableHttp',
    })
    .option('logLevel', {
      choices: ['debug', 'info', 'none'] as const,
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
    .option('stateful', {
      type: 'boolean',
      default: false,
      description:
        'Whether the server is stateful. Only supported for stdio→StreamableHttp.',
    })
    .option('sessionTimeout', {
      type: 'number',
      description:
        'Session timeout in milliseconds. Only supported for stateful stdio→StreamableHttp. If not set, the session will only be deleted when client transport explicitly terminates the session.',
    })
    .option('protocolVersion', {
      type: 'string',
      description:
        'MCP protocol version to use for auto-initialization. Defaults to "2024-11-05" if not specified.',
      default: '2024-11-05',
    })
    .help()
    .parseSync()

  const hasStdio = Boolean(argv.stdio)
  const hasSse = Boolean(argv.sse)
  const hasStreamableHttp = Boolean(argv.streamableHttp)
  const hasMultiServerConfig = Boolean(argv.multiServerConfig)

  const activeCount = [
    hasStdio,
    hasSse,
    hasStreamableHttp,
    hasMultiServerConfig,
  ].filter(Boolean).length

  const stdioValues = (argv.stdio as string[] | undefined) ?? []
  const isStdioMapCli =
    stdioValues.length > 0 && stdioValues.every((v) => v.includes('='))

  const logger = getLogger({
    logLevel: argv.logLevel,
    outputTransport: argv.outputTransport as string,
  })

  if (activeCount === 0) {
    logger.error(
      'Error: You must specify one of --stdio, --sse, or --streamableHttp',
    )
    process.exit(1)
  } else if (activeCount > 1) {
    logger.error(
      'Error: Specify only one of --stdio, --sse, or --streamableHttp, not multiple',
    )
    process.exit(1)
  }

  logger.info('Starting...')
  logger.info(
    'Supergateway is supported by Supermachine (hosted MCPs) - https://supermachine.ai',
  )
  logger.info(`  - outputTransport: ${argv.outputTransport}`)

  try {
    if (hasMultiServerConfig) {
      if (hasStdio || hasSse || hasStreamableHttp) {
        logger.error(
          'Error: --multiServerConfig cannot be combined with --stdio, --sse, or --streamableHttp',
        )
        process.exit(1)
      }
      const configPath = argv.multiServerConfig as string
      let configRaw: string
      try {
        configRaw = await readFile(configPath, 'utf8')
      } catch (err) {
        logger.error(
          `Error: Failed to read multi-server config file at ${configPath}:`,
          err,
        )
        process.exit(1)
      }

      let configJson: unknown
      try {
        configJson = JSON.parse(configRaw)
      } catch (err) {
        logger.error('Error: Failed to parse multi-server config JSON:', err)
        process.exit(1)
      }

      const servers =
        (configJson &&
          typeof configJson === 'object' &&
          Array.isArray((configJson as any).servers) &&
          (configJson as any).servers.map((s: any, index: number) => {
            if (!s || typeof s !== 'object') {
              logger.error(
                `Error: Invalid server entry at index ${index} in multi-server config`,
              )
              process.exit(1)
            }

            const path = typeof s.path === 'string' ? s.path : ''
            const stdioCmd = typeof s.stdio === 'string' ? s.stdio : ''

            if (!path || !stdioCmd) {
              logger.error(
                `Error: Each server in multi-server config must have non-empty "path" and "stdio" fields (index ${index})`,
              )
              process.exit(1)
            }

            const normalizedPath = path.startsWith('/') ? path : `/${path}`

            return {
              path: normalizedPath,
              stdioCmd,
            }
          })) ||
        []

      if (!servers.length) {
        logger.error(
          'Error: multi-server config must define at least one server in "servers" array',
        )
        process.exit(1)
      }

      if (argv.outputTransport === 'streamableHttp') {
        if (argv.stateful) {
          const app = express()

          await multiStdioToStatefulStreamableHttp(
            {
              servers,
              port: argv.port,
              streamableHttpPath: argv.streamableHttpPath,
              logger,
              corsOrigin: corsOrigin({ argv }),
              healthEndpoints: argv.healthEndpoint as string[],
              headers: headers({
                argv,
                logger,
              }),
              sessionTimeout:
                typeof argv.sessionTimeout === 'number'
                  ? argv.sessionTimeout
                  : null,
            },
            app,
          )

          app.listen(argv.port, () => {
            logger.info(
              `Stateful Streamable HTTP multi-server listening on port ${argv.port}`,
            )
          })
        } else {
          const app = express()

          await multiStdioToStatelessStreamableHttp(
            {
              servers,
              port: argv.port,
              streamableHttpPath: argv.streamableHttpPath,
              logger,
              corsOrigin: corsOrigin({ argv }),
              healthEndpoints: argv.healthEndpoint as string[],
              headers: headers({
                argv,
                logger,
              }),
              protocolVersion: argv.protocolVersion,
            },
            app,
          )

          app.listen(argv.port, () => {
            logger.info(
              `Stateless Streamable HTTP multi-server listening on port ${argv.port}`,
            )
          })
        }
      } else if (argv.outputTransport === 'sse') {
        if (argv.stateful) {
          logger.error(
            'Error: --stateful is not supported for stdio→SSE multi-server mode',
          )
          process.exit(1)
        }

        const app = express()

        await multiStdioToSse(
          {
            servers,
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
          },
          app,
        )

        app.listen(argv.port, () => {
          logger.info(`SSE multi-server listening on port ${argv.port}`)
        })
      } else if (argv.outputTransport === 'ws') {
        if (argv.stateful) {
          logger.error(
            'Error: --stateful is not supported for stdio→WS multi-server mode',
          )
          process.exit(1)
        }

        const app = express()

        await multiStdioToWs(
          {
            servers,
            port: argv.port,
            messagePath: argv.messagePath,
            logger,
            corsOrigin: corsOrigin({ argv }),
            healthEndpoints: argv.healthEndpoint as string[],
          },
          app,
        )
      } else {
        logger.error(
          'Error: --multiServerConfig requires --outputTransport sse, ws, or streamableHttp',
        )
        process.exit(1)
      }
    } else if (isStdioMapCli) {
      if (hasSse || hasStreamableHttp) {
        logger.error(
          'Error: When using --stdio name=command form, do not also pass --sse or --streamableHttp',
        )
        process.exit(1)
      }

      const servers = stdioValues.map((value, index) => {
        const eqIndex = value.indexOf('=')
        if (eqIndex === -1) {
          logger.error(
            `Error: Invalid --stdio value at position ${index}. Expected name=command format.`,
          )
          process.exit(1)
        }

        const name = value.slice(0, eqIndex).trim()
        const cmd = value.slice(eqIndex + 1).trim()

        if (!name || !cmd) {
          logger.error(
            `Error: Invalid --stdio value at position ${index}. Both name and command must be non-empty.`,
          )
          process.exit(1)
        }

        const path = name.startsWith('/') ? name : `/${name}`

        return {
          path,
          stdioCmd: cmd,
        }
      })

      if (argv.outputTransport === 'streamableHttp') {
        if (argv.stateful) {
          const app = express()

          await multiStdioToStatefulStreamableHttp(
            {
              servers,
              port: argv.port,
              streamableHttpPath: argv.streamableHttpPath,
              logger,
              corsOrigin: corsOrigin({ argv }),
              healthEndpoints: argv.healthEndpoint as string[],
              headers: headers({
                argv,
                logger,
              }),
              sessionTimeout:
                typeof argv.sessionTimeout === 'number'
                  ? argv.sessionTimeout
                  : null,
            },
            app,
          )
          app.listen(argv.port, () => {
            logger.info(
              `Stateful Streamable HTTP multi-server listening on port ${argv.port}`,
            )
          })
        } else {
          const app = express()

          await multiStdioToStatelessStreamableHttp(
            {
              servers,
              port: argv.port,
              streamableHttpPath: argv.streamableHttpPath,
              logger,
              corsOrigin: corsOrigin({ argv }),
              healthEndpoints: argv.healthEndpoint as string[],
              headers: headers({
                argv,
                logger,
              }),
              protocolVersion: argv.protocolVersion,
            },
            app,
          )

          app.listen(argv.port, () => {
            logger.info(
              `Stateless Streamable HTTP multi-server listening on port ${argv.port}`,
            )
          })
        }
      } else if (argv.outputTransport === 'sse') {
        if (argv.stateful) {
          logger.error(
            'Error: --stateful is not supported for stdio→SSE multi-server mode',
          )
          process.exit(1)
        }

        const app = express()

        await multiStdioToSse(
          {
            servers,
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
          },
          app,
        )

        app.listen(argv.port, () => {
          logger.info(`SSE multi-server listening on port ${argv.port}`)
        })
      } else if (argv.outputTransport === 'ws') {
        if (argv.stateful) {
          logger.error(
            'Error: --stateful is not supported for stdio→WS multi-server mode',
          )
          process.exit(1)
        }

        const app = express()

        await multiStdioToWs(
          {
            servers,
            port: argv.port,
            messagePath: argv.messagePath,
            logger,
            corsOrigin: corsOrigin({ argv }),
            healthEndpoints: argv.healthEndpoint as string[],
          },
          app,
        )
      } else {
        logger.error(
          'Error: Multi-server --stdio name=command form requires --outputTransport sse, ws, or streamableHttp',
        )
        process.exit(1)
      }
    } else if (hasStdio) {
      const stdioArg = Array.isArray(argv.stdio)
        ? (argv.stdio[0] as string | undefined)
        : (argv.stdio as string | undefined)

      if (!stdioArg) {
        logger.error('Error: --stdio requires a command')
        process.exit(1)
      }

      if (argv.outputTransport === 'sse') {
        const app = express()

        await stdioToSse(
          {
            stdioCmd: stdioArg,
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
          },
          app,
        )

        app.listen(argv.port, () => {
          logger.info(`SSE server listening on port ${argv.port}`)
        })
      } else if (argv.outputTransport === 'ws') {
        const app = express()

        await stdioToWs(
          {
            stdioCmd: stdioArg,
            port: argv.port,
            messagePath: argv.messagePath,
            logger,
            corsOrigin: corsOrigin({ argv }),
            healthEndpoints: argv.healthEndpoint as string[],
          },
          app,
        )
      } else if (argv.outputTransport === 'streamableHttp') {
        const stateful = argv.stateful
        if (stateful) {
          logger.info('Running stateful server')

          let sessionTimeout: null | number
          if (typeof argv.sessionTimeout === 'number') {
            if (argv.sessionTimeout <= 0) {
              logger.error(
                `Error: \`sessionTimeout\` must be a positive number, received: ${argv.sessionTimeout}`,
              )
              process.exit(1)
            }

            sessionTimeout = argv.sessionTimeout
          } else {
            sessionTimeout = null
          }

          const app = express()

          await stdioToStatefulStreamableHttp(
            {
              stdioCmd: stdioArg,
              port: argv.port,
              streamableHttpPath: argv.streamableHttpPath,
              logger,
              corsOrigin: corsOrigin({ argv }),
              healthEndpoints: argv.healthEndpoint as string[],
              headers: headers({
                argv,
                logger,
              }),
              sessionTimeout,
            },
            app,
          )

          app.listen(argv.port, () => {
            logger.info(
              `Stateful Streamable HTTP server listening on port ${argv.port}`,
            )
          })
        } else {
          logger.info('Running stateless server')

          const app = express()

          await stdioToStatelessStreamableHttp(
            {
              stdioCmd: stdioArg,
              port: argv.port,
              streamableHttpPath: argv.streamableHttpPath,
              logger,
              corsOrigin: corsOrigin({ argv }),
              healthEndpoints: argv.healthEndpoint as string[],
              headers: headers({
                argv,
                logger,
              }),
              protocolVersion: argv.protocolVersion,
            },
            app,
          )

          app.listen(argv.port, () => {
            logger.info(
              `Stateless Streamable HTTP server listening on port ${argv.port}`,
            )
          })
        }
      } else {
        logger.error(`Error: stdio→${argv.outputTransport} not supported`)
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
        logger.error(`Error: sse→${argv.outputTransport} not supported`)
        process.exit(1)
      }
    } else if (hasStreamableHttp) {
      if (argv.outputTransport === 'stdio') {
        await streamableHttpToStdio({
          streamableHttpUrl: argv.streamableHttp!,
          logger,
          headers: headers({
            argv,
            logger,
          }),
        })
      } else {
        logger.error(
          `Error: streamableHttp→${argv.outputTransport} not supported`,
        )
        process.exit(1)
      }
    } else {
      logger.error('Error: Invalid input transport')
      process.exit(1)
    }
  } catch (err) {
    logger.error('Fatal error:', err)
    process.exit(1)
  }
}

main()
