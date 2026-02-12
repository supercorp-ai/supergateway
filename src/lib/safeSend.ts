import type { Logger } from '../types.js'

type TransportLike = {
  // Different MCP transports have slightly different `send` signatures.
  // We only care that the first arg is the JSON-RPC message, and that it may
  // throw or return a Promise that can reject.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send: (...args: any[]) => any
}

export function safeTransportSend(args: {
  transport: TransportLike
  message: unknown
  logger: Logger
  context: string
}) {
  const { transport, message, logger, context } = args

  try {
    // `send` can throw synchronously or reject asynchronously depending on the
    // underlying transport + request lifecycle. We must handle both.
    Promise.resolve(transport.send(message)).catch((err) => {
      logger.error(`${context}: transport.send rejected`, err)
    })
  } catch (err) {
    logger.error(`${context}: transport.send threw`, err)
  }
}
