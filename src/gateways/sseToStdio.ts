import type { Logger } from '../types.js'
import {
  type BridgeLifecycle,
  bridgeStdioMessages,
} from '../lib/stdioBridge.js'
import type { ToolNames } from '../lib/toolNames.js'
import { onSignals } from '../lib/onSignals.js'
import { parseUpstreamUrl, redactUrl } from '../lib/urlCredentials.js'
import { describeHeaders } from '../lib/headers.js'
import {
  openSseTransport,
  Upstream,
  SseHandshakeTimeout,
} from './sseUpstream.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { getVersion } from '../lib/getVersion.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

export interface SseToStdioArgs {
  sseUrl: string
  logger: Logger
  headers: Record<string, string>
  /** Alone by default: the bridge registers the signals and exits itself. */
  lifecycle?: BridgeLifecycle
  /** The tools the stdio client sees of the server, if not all as they are. */
  toolNames?: ToolNames
}

export async function sseToStdio(args: SseToStdioArgs) {
  const {
    sseUrl,
    logger,
    headers,
    toolNames,
    // It has nothing of its own to clean up at a signal.
    lifecycle = {
      register: () => onSignals({ logger }),
      exit: (code) => process.exit(code),
    },
  } = args

  const upstreamUrl = parseUpstreamUrl(sseUrl)

  logger.info(`  - sse: ${redactUrl(upstreamUrl)}`)
  logger.info(`  - Headers: ${describeHeaders(headers)}`)
  toolNames?.describe().forEach((setting) => logger.info(`  - ${setting}`))
  logger.info('Connecting to SSE...')

  lifecycle.register()

  const { transport: sseTransport, stream } = openSseTransport(
    upstreamUrl,
    headers,
    logger,
    lifecycle.exit,
  )
  const upstream = new Upstream(sseTransport, stream, upstreamUrl, logger)

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
    label: 'SSE',
    logger,
    request: (req, signal) => upstream.request(req, signal),
    // The SDK's transport cannot be started a second time, so after a
    // handshake that timed out there is nothing left to serve. Closing it
    // exits through `onclose`, once the client has been told why.
    failed: (err) =>
      err instanceof SseHandshakeTimeout
        ? () => void sseTransport.close()
        : undefined,
    send: () =>
      upstream.client ? (relayed) => sseTransport.send(relayed) : undefined,
  })

  logger.info('Stdio server listening')
}
