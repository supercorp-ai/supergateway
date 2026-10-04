import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type {
  ClientCapabilities,
  Implementation,
  JSONRPCMessage,
  JSONRPCRequest,
} from '@modelcontextprotocol/sdk/types.js'
import { Logger } from '../types.js'
import { getVersion } from './getVersion.js'
import { CancellableRequests } from './cancellableRequests.js'
import { errorResponse, resultResponse } from './bridgeResponses.js'
import { relayClientMessage } from './relayClientMessage.js'
import type { ToolNames } from './toolNames.js'

// The stdio side of the bridges (--sse, --streamableHttp), which both used to
// write out in full. Nothing here imports the SDK's classes, only their types:
// each bridge constructs its own `Client`, `Server` and transports, which the
// bridge tests replace per test.

/**
 * How a bridge's life is tied to the process: where it registers what to do
 * at shutdown, and how it exits. Alone, a bridge registers the signals itself
 * and exits the process; beside other servers, the gateway passes its own,
 * so a bridge that stops stops the others the way a signal does.
 */
export interface BridgeLifecycle {
  register(cleanup?: () => Promise<void>): void
  exit(code: number): void
}

/**
 * The name and capabilities a bridge's upstream `Client` presents: the stdio
 * client's own, from its initialize request, or the gateway's when the first
 * request was something else.
 */
export const upstreamClientIdentity = (initialize?: JSONRPCRequest) => {
  const clientInfo = initialize?.params?.clientInfo as
    Implementation | undefined
  const clientCapabilities = initialize?.params?.capabilities as
    ClientCapabilities | undefined
  return [
    {
      name: clientInfo?.name ?? 'supergateway',
      version: clientInfo?.version ?? getVersion(),
    },
    {
      capabilities: clientCapabilities ?? {},
    },
  ] as const
}

/**
 * Pass each request `client` sends through `rewrite` first, and keep what the
 * latest one returned, until `restore` puts the client back as it was. A
 * bridge connects its upstream client this way: the initialize request that
 * `Client.connect` sends must carry the stdio client's protocol version, and
 * its result is the reply to the stdio client's own initialize.
 */
export const interceptRequests = (
  client: Client,
  rewrite: (request: Parameters<Client['request']>[0]) => void,
) => {
  const originalRequest = client.request
  let latestResult: unknown
  client.request = async function (request, ...restArgs) {
    rewrite(request)
    latestResult = await originalRequest.apply(this, [request, ...restArgs])
    return latestResult as Awaited<ReturnType<typeof originalRequest>>
  }
  return {
    result: () => latestResult,
    restore: () => {
      client.request = originalRequest
    },
  }
}

/**
 * Handle every message the stdio client sends. A request goes upstream through
 * `request` and its outcome comes back as a reply; a cancellation aborts the
 * request it names; anything else is relayed through whatever `send` returns
 * at the time.
 *
 * `Attempt` is what a bridge records about one request while sending it, for
 * `failed` to read. It starts empty.
 */
export function bridgeStdioMessages<Attempt extends object>(
  transport: Transport,
  {
    label,
    logger,
    request,
    failed,
    send,
    toolNames,
  }: {
    label: string
    logger: Logger
    /** The tools the stdio client sees of the server, if not all as they are. */
    toolNames?: ToolNames
    request: (
      req: JSONRPCRequest,
      signal: AbortSignal,
      attempt: Attempt,
    ) => Promise<unknown>
    // What the bridge does about a failed request, once the failure is logged
    // and before the client's error reply is written. It may return what to do
    // once that reply has been written.
    failed: (err: unknown, attempt: Attempt) => (() => void) | void
    send: () => ((message: JSONRPCMessage) => Promise<void>) | undefined
  },
) {
  const inFlight = new CancellableRequests(logger)

  const handleStdioMessage = async (message: JSONRPCMessage) => {
    const isRequest = 'method' in message && 'id' in message
    if (isRequest) {
      logger.info(`Stdio → ${label}:`, message)
      // A call to a tool the client can't see is answered here; any other
      // goes on under the server's own name.
      const sent = toolNames?.inbound(message) ?? { forward: message }
      if ('reply' in sent) {
        process.stdout.write(JSON.stringify(sent.reply) + '\n')
        return
      }
      const req = sent.forward as JSONRPCRequest
      let result
      const signal = inFlight.begin(req.id)
      const attempt = {} as Attempt

      try {
        result = await request(req, signal, attempt)
      } catch (err) {
        inFlight.end(req.id)
        // The client cancelled it, and expects no reply.
        if (signal.aborted) return
        logger.error('Request error:', err)
        const written = failed(err, attempt)
        const line = JSON.stringify(errorResponse(req, err)) + '\n'
        if (written) process.stdout.write(line, written)
        else process.stdout.write(line)
        return
      }
      // Answered, so there is nothing left to cancel.
      inFlight.end(req.id)
      // See resultResponse: whatever `request` returned is a result.
      const response = resultResponse(
        req,
        toolNames && req.method === 'tools/list'
          ? toolNames.listed(result as Record<string, unknown>)
          : (result as object),
      )
      logger.info('Response:', response)
      process.stdout.write(JSON.stringify(response) + '\n')
    } else if (!inFlight.cancel(message)) {
      await relayClientMessage({ message, send: send(), label, logger })
    }
  }

  // The SDK calls `onmessage` synchronously and drops whatever it returns, so
  // an async handler assigned straight to it had nothing holding its promise:
  // any throw became an unhandled rejection, which Node turns into an immediate
  // exit. The tail of the handler is outside its own try/catch and dereferences
  // `result`, which is never assigned on the fallback path — so this was
  // reachable by a client whose first request is not `initialize`.
  //
  // This stops that being fatal. It does not make the request succeed: the
  // client still gets no reply, which is GW-001's separate defect.
  // The promise is deliberately returned rather than dropped: tests drive this
  // handler directly and await it, and the SDK ignoring the value costs
  // nothing. `no-misused-promises` exists to stop a rejection escaping a void
  // slot, and the `.catch` below is exactly that guarantee — it handles every
  // rejection and cannot itself throw — so the rule's concern does not apply.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  transport.onmessage = (message: JSONRPCMessage) =>
    handleStdioMessage(message).catch((err) => {
      logger.error('Unhandled error while handling a stdio message:', err)
    })
}
