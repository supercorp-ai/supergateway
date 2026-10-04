import type express from 'express'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { Logger } from '../types.js'

/**
 * When a Streamable HTTP request's or session's child fails: answer every
 * call it had not answered, then close the transport.
 *
 * Ending an SSE response alone leaves SDK clients waiting for their request
 * timeout, so each outstanding call gets an error first. A spawn failure can
 * precede SDK response registration; a completed response is not destroyed,
 * since its error frame must flush first.
 */
export function failPendingCalls({
  transport,
  pending,
  res,
  logger,
}: {
  transport: Transport
  pending: Set<string | number>
  res: express.Response
  logger: Logger
}) {
  const replies = [...pending].map((id) =>
    transport
      .send({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: 'MCP server process failed' },
      })
      .catch((sendError) => {
        logger.error('Failed to send child failure', sendError)
      }),
  )
  pending.clear()
  void Promise.all(replies)
    .then(() => transport.close())
    .catch((closeError) => {
      logger.error('Failed to close transport after child failure', closeError)
    })
    .finally(() => {
      if (!res.writableEnded) res.destroy()
    })
}
