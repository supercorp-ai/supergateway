import type { Logger } from '../types.js'
import {
  type BridgeLifecycle,
  bridgeStdioMessages,
} from '../lib/stdioBridge.js'
import type { ToolNames } from '../lib/toolNames.js'
import { onSignals } from '../lib/onSignals.js'
import { parseUpstreamUrl, redactUrl } from '../lib/urlCredentials.js'
import { describeHeaders } from '../lib/headers.js'
import { Upstream, type Attempt } from './streamableHttpUpstream.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { getVersion } from '../lib/getVersion.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

export interface StreamableHttpToStdioArgs {
  streamableHttpUrl: string
  logger: Logger
  headers: Record<string, string>
  /** Alone by default: the bridge registers the signals and exits itself. */
  lifecycle?: BridgeLifecycle
  /** The tools the stdio client sees of the server, if not all as they are. */
  toolNames?: ToolNames
}

export async function streamableHttpToStdio(args: StreamableHttpToStdioArgs) {
  const {
    streamableHttpUrl,
    logger,
    headers,
    toolNames,
    lifecycle = {
      register: (cleanup) => onSignals({ logger, cleanup }),
      exit: (code) => process.exit(code),
    },
  } = args
  const upstreamUrl = parseUpstreamUrl(streamableHttpUrl)

  logger.info(`  - streamableHttp: ${redactUrl(upstreamUrl)}`)
  logger.info(`  - Headers: ${describeHeaders(headers)}`)
  toolNames?.describe().forEach((setting) => logger.info(`  - ${setting}`))
  logger.info('Connecting to Streamable HTTP...')

  const upstream = new Upstream(upstreamUrl, headers, logger, lifecycle.exit)

  // A stateful upstream keeps this session, and the server process behind it,
  // until the session is ended or times out (30 minutes by default). Ending
  // it is the client's job, and the bridge is the client.
  lifecycle.register(() => upstream.endSession())

  const stdioServer = new Server(
    {
      name: 'supergateway',
      version: getVersion(),
    },
    {
      capabilities: {},
    },
  )

  const stdioTransport = new StdioServerTransport()
  await stdioServer.connect(stdioTransport)

  bridgeStdioMessages(stdioServer.transport!, {
    toolNames,
    label: 'Streamable HTTP',
    logger,
    request: (req, signal, attempt: Attempt) =>
      upstream.request(req, signal, attempt),
    failed: (err, attempt) => upstream.failed(err, attempt),
    send: () =>
      upstream.connection
        ? (relayed) => upstream.connection!.transport.send(relayed)
        : undefined,
  })

  logger.info('Stdio server listening')
}
