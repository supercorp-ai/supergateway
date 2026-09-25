import type { ErrorRequestHandler } from 'express'

/**
 * A request body that `express.json()` rejects, answered as JSON-RPC.
 *
 * Express's default handler answered invalid JSON, an unsupported charset or a
 * body over the limit with an HTML page, and unless NODE_ENV was `production`
 * that page carried the stack trace with the server's absolute file paths. A
 * JSON-RPC client can't read HTML, and the spec answers malformed JSON with a
 * parse error (-32700). The status codes stay what they were.
 *
 * Mount it right after `express.json()`. Only the parser's errors reach it
 * there, and every one of them carries its HTTP status.
 */
export const jsonBodyErrors: ErrorRequestHandler = (err, _req, res, _next) => {
  const parse = err.type === 'entity.parse.failed'
  res.status(err.status).json({
    jsonrpc: '2.0',
    error: {
      code: parse ? -32700 : -32000,
      message: parse
        ? 'Parse error: invalid JSON'
        : `Bad Request: ${err.message}`,
    },
    id: null,
  })
}
