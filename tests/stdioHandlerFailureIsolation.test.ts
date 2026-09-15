import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialize } from './helpers/gateway-process.js'

/**
 * The reverse bridges hand `onmessage` a promise-returning function and attach a
 * `.catch` to it. The SDK calls `onmessage` synchronously and drops whatever it
 * returns, so without that handler a rejection has nothing holding it: Node
 * reports an unhandled rejection and exits immediately, taking a working gateway
 * down with it.
 *
 * GW-001 used to supply the rejection — the fallback path left `result` unset
 * and the tail of the handler dereferenced it. That defect is fixed, so the
 * `.catch` now guards a class of failure the bridge no longer produces itself,
 * and nothing exercised it. It is still worth having and still worth proving:
 * the handler logs before its own try block, and a logger writing to a stdout
 * the parent has closed throws `ERR_STREAM_DESTROYED`. That is an ordinary way
 * for a gateway to lose its output, not a manufactured state — so a logger that
 * throws is what this drives it with.
 *
 * The property is narrow and exact: the rejection is reported through
 * `logger.error` and the promise `onmessage` returns settles instead of
 * rejecting.
 */
for (const protocol of ['sse', 'streamableHttp'] as const) {
  test(`${protocol} bridge reports a handler failure instead of dying of it`, async (t) => {
    let stdio: any
    class Client {
      async connect() {}
      async request() {
        return { tools: [] }
      }
    }
    class RemoteTransport {}
    class Server {
      transport: any
      async connect(transport: unknown) {
        this.transport = transport
        stdio = transport
      }
    }
    t.mock.module('@modelcontextprotocol/sdk/client/index.js', {
      namedExports: { Client },
    })
    t.mock.module('@modelcontextprotocol/sdk/server/index.js', {
      namedExports: { Server },
    })
    t.mock.module('@modelcontextprotocol/sdk/server/stdio.js', {
      namedExports: { StdioServerTransport: class {} },
    })
    t.mock.module('@modelcontextprotocol/sdk/client/sse.js', {
      namedExports: { SSEClientTransport: RemoteTransport },
    })
    t.mock.module('@modelcontextprotocol/sdk/client/streamableHttp.js', {
      namedExports: { StreamableHTTPClientTransport: RemoteTransport },
    })
    t.mock.module(new URL('../src/lib/onSignals.js', import.meta.url).href, {
      namedExports: { onSignals() {} },
    })
    const module =
      protocol === 'sse'
        ? await import('../src/gateways/sseToStdio.js')
        : await import('../src/gateways/streamableHttpToStdio.js')

    // Stdout is closed under the bridge, the way a parent that has gone away
    // closes it. Every write the logger attempts after that throws.
    const lost = new Error('ERR_STREAM_DESTROYED')
    let stdoutIsGone = false
    const reported: unknown[][] = []
    const logger = {
      info(...args: unknown[]) {
        if (stdoutIsGone) throw lost
        void args
      },
      error(...args: unknown[]) {
        reported.push(args)
      },
    }
    t.mock.method(process.stdout, 'write', () => true)

    const url = `http://127.0.0.1:54321/${protocol === 'sse' ? 'sse' : 'mcp'}`
    if ('sseToStdio' in module)
      await module.sseToStdio({ sseUrl: url, logger, headers: {} })
    else
      await module.streamableHttpToStdio({
        streamableHttpUrl: url,
        logger,
        headers: {},
      })

    // The handler is reached the ordinary way first, so the failure below is a
    // change in the gateway's surroundings rather than in how it is driven.
    await stdio.onmessage(initialize(1))
    assert.deepEqual(reported, [], 'a healthy handler reports nothing')

    stdoutIsGone = true
    const settled = stdio.onmessage({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    })
    await assert.doesNotReject(
      settled,
      'the promise onmessage returns must settle, or Node exits on the rejection',
    )
    assert.deepEqual(
      reported,
      [['Unhandled error while handling a stdio message:', lost]],
      'the failure is reported once, naming what was thrown',
    )

    // And the bridge is still driveable: the guard absorbs the failure rather
    // than leaving the handler in a state that cannot take another message.
    stdoutIsGone = false
    await assert.doesNotReject(
      stdio.onmessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      'the bridge keeps serving once its output comes back',
    )
  })
}
