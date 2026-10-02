import { setTimeout as delay } from 'node:timers/promises'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  isInitializeRequest,
  type JSONRPCMessage,
  type JSONRPCRequest,
} from '@modelcontextprotocol/sdk/types.js'
import type { Logger } from '../types.js'
import type { StartPeer } from './childHandoff.js'
import type { OwnedChildProcesses } from './ownedChildProcesses.js'
import { readWhile } from './outputBackpressure.js'

/** A remote MCP server, served over HTTP as if it were a local one. */
export interface RemoteServer {
  url: URL
  type: 'sse' | 'streamableHttp'
  /** Sent to the remote server: --header and --oauth2Bearer. */
  headers: Record<string, string>
}

/**
 * A session with a remote server, as the peer of one client session: what the
 * client sends is relayed to it unchanged, and what it sends back, so
 * sampling, roots and elicitation cross as they do with a local child.
 *
 * Each client session has its own upstream session, as each has its own child.
 * The upstream sees only the configured headers: never the client's own
 * Authorization or the gateway's API key, which would pass the client's token
 * to a server it was not issued for.
 */
export const upstreamPeer =
  (
    remote: RemoteServer,
    children: OwnedChildProcesses,
    logger: Logger,
    label: string,
  ): StartPeer =>
  (owner) => {
    let gone = false
    let initializeId: string | number | undefined
    // Settles the wait for initialize's answer; set when initialize is sent.
    let answered!: () => void
    // Read the remote server's responses only as fast as the client reads.
    const held = async (...props: Parameters<typeof fetch>) =>
      readWhile(await fetch(...props), () => owner.output())
    const transport =
      remote.type === 'sse'
        ? new SSEClientTransport(remote.url, {
            eventSourceInit: {
              fetch: async (url, init) => {
                // The SDK always passes `init`, with a `Headers` object, which
                // spreading loses; merge, and let the configured headers win.
                const merged = new Headers(init!.headers)
                for (const [name, value] of Object.entries(remote.headers))
                  merged.set(name, value)
                return held(url, { ...init, headers: merged })
              },
            },
            requestInit: { headers: remote.headers },
          })
        : new StreamableHTTPClientTransport(remote.url, {
            requestInit: { headers: remote.headers },
            fetch: held,
          })

    const stop = children.track(async () => {
      if (transport instanceof StreamableHTTPClientTransport)
        // Bounded: a remote server that does not answer must not hold up a
        // session's end, or the gateway's.
        await Promise.race([
          transport
            .terminateSession()
            .catch((err) =>
              logger.error(
                `${label}: failed to end the upstream session:`,
                err,
              ),
            ),
          delay(2000, undefined, { ref: false }),
        ])
      await transport.close()
    })
    const fail = (err: Error) => owner.failure('upstream', err)

    transport.onmessage = (message: JSONRPCMessage) => {
      // The answer to initialize sets the version later requests declare.
      if ('id' in message && message.id === initializeId) {
        initializeId = undefined
        if ('result' in message)
          transport.setProtocolVersion(
            (message.result as { protocolVersion: string }).protocolVersion,
          )
        answered()
      }
      owner.message(message, JSON.stringify(message))
    }
    transport.onerror = (err) => logger.error(`${label}: upstream error:`, err)
    // Called by close(), which only `stop` calls, once. A remote server that
    // goes away is noticed by the next message sent to it failing.
    transport.onclose = () => {
      gone = true
      owner.exit(null, null)
    }

    // Everything waits for the connection. After initialize, everything
    // waits for its answer too: until then the session has no version to
    // declare, and on Streamable HTTP no id. One that fails to send fails the
    // session, and what follows is sent, and fails, as it would have.
    let ready: Promise<unknown> = transport.start().catch(fail)
    return {
      write: (message) => {
        const sent = ready.then(() => transport.send(message))
        sent.catch(fail)
        if (!isInitializeRequest(message)) return
        initializeId = (message as JSONRPCRequest).id
        ready = Promise.all([
          sent,
          new Promise<void>((resolve) => (answered = resolve)),
        ]).catch(() => {})
      },
      end: () => {
        void ready.then(stop)
      },
      stop,
      get gone() {
        return gone
      },
    }
  }
