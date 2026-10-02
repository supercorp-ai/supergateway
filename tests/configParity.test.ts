import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
// The `ws` client, not the global one: `WebSocket` is undefined on Node 20.
import { WebSocket } from 'ws'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import {
  gatewayTimeout,
  initialize,
  launchGateway,
  peerCommand,
  requestTimeout,
  rpc,
  stdioRpc,
  unusedPort,
} from './helpers/gateway-process.js'

// A command line and the file `--printConfig` turns it into are the same
// gateway: the same startup log, line for line, and the same answer to an MCP
// request. The cases carry no secrets, which --printConfig redacts.

const prefix = '[supergateway] '

type Gateway = ReturnType<typeof launchGateway>

type Case = {
  name: string
  args: (port: number, upstream: number) => string[]
  // The upstream gateway a bridge connects to, if any.
  upstream?: string[]
  // The last startup line, and the stream it is written to.
  done: RegExp
  // One MCP request, as a value two runs can be compared by.
  exercise: (t: TestContext, gateway: Gateway, port: number) => Promise<unknown>
}

const overSse =
  (ssePath: string) => async (t: TestContext, _g: Gateway, port: number) => {
    const client = new Client({ name: 'parity', version: '1.0.0' })
    t.after(() => client.close())
    await client.connect(
      new SSEClientTransport(new URL(`http://127.0.0.1:${port}${ssePath}`)),
    )
    const { tools } = await client.listTools()
    return { server: client.getServerVersion(), tools }
  }

const overHttp =
  (path: string) => async (_t: TestContext, _g: Gateway, port: number) => {
    const { response, messages } = await rpc(
      `http://127.0.0.1:${port}${path}`,
      initialize(),
    )
    return {
      status: response.status,
      session: response.headers.has('mcp-session-id'),
      messages,
    }
  }

const overWs = async (_t: TestContext, _g: Gateway, port: number) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/message`)
  try {
    await once(socket, 'open')
    socket.send(JSON.stringify(initialize()))
    const [data] = await Promise.race([
      once(socket, 'message'),
      delay(requestTimeout(5000), undefined, { ref: false }).then(() => {
        throw Error('no reply over WebSocket')
      }),
    ])
    return JSON.parse(String(data))
  } finally {
    socket.close()
  }
}

const overStdio = async (_t: TestContext, gateway: Gateway) =>
  stdioRpc(gateway, initialize())

const cases: Case[] = [
  {
    name: 'stdio→SSE with --baseUrl, --cors and --healthEndpoint',
    args: (port) => [
      '--stdio',
      peerCommand,
      '--port',
      String(port),
      '--baseUrl',
      `http://localhost:${port}`,
      '--cors',
      'http://a.example',
      '--healthEndpoint',
      '/healthz',
    ],
    done: /^POST messages:/,
    exercise: overSse('/sse'),
  },
  {
    name: 'stdio→SSE with its paths and a --header',
    args: (port) => [
      '--stdio',
      peerCommand,
      '--port',
      String(port),
      '--ssePath',
      '/events',
      '--messagePath',
      'msgs',
      '--header',
      'x-trace: on',
    ],
    done: /^POST messages:/,
    exercise: overSse('/events'),
  },
  {
    name: 'stdio→WS with --host and --cors',
    args: (port) => [
      '--stdio',
      peerCommand,
      '--outputTransport',
      'ws',
      '--port',
      String(port),
      '--host',
      '127.0.0.1',
      '--cors',
      '--healthEndpoint',
      '/h',
    ],
    done: /^WebSocket endpoint:/,
    exercise: overWs,
  },
  {
    name: 'stateless Streamable HTTP with a path, a header and a protocol version',
    args: (port) => [
      '--stdio',
      peerCommand,
      '--outputTransport',
      'streamableHttp',
      '--port',
      String(port),
      '--streamableHttpPath',
      '/rpc',
      '--header',
      'x-team: core',
      '--protocolVersion',
      '2025-03-26',
    ],
    done: /^StreamableHttp endpoint:/,
    exercise: overHttp('/rpc'),
  },
  {
    name: 'stateful Streamable HTTP with --sessionTimeout and --cors',
    args: (port) => [
      '--stdio',
      peerCommand,
      '--outputTransport',
      'streamableHttp',
      '--stateful',
      '--sessionTimeout',
      '60000',
      '--port',
      String(port),
      '--cors',
    ],
    done: /^StreamableHttp endpoint:/,
    exercise: overHttp('/mcp'),
  },
  {
    name: 'Streamable HTTP→stdio with a --header',
    upstream: ['--outputTransport', 'streamableHttp'],
    args: (_port, upstream) => [
      '--streamableHttp',
      `http://127.0.0.1:${upstream}/mcp`,
      '--header',
      'x-trace: on',
    ],
    done: /^Stdio server listening/,
    exercise: overStdio,
  },
  {
    name: 'SSE→stdio',
    upstream: ['--outputTransport', 'sse'],
    args: (_port, upstream) => ['--sse', `http://127.0.0.1:${upstream}/sse`],
    done: /^Stdio server listening/,
    exercise: overStdio,
  },
]

const ended = (stream: Readable) =>
  stream.readableEnded ? Promise.resolve() : once(stream, 'end')

const logLines = (text: string) =>
  text
    .split('\n')
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length))

// Starts a gateway, and returns its startup log, stream by stream, and its
// answer to one request.
const observe = async (
  t: TestContext,
  item: Case,
  args: string[],
  port: number,
) => {
  const gateway = launchGateway(t, args)
  await gateway.waitFor(
    () =>
      [gateway.output(), gateway.errors()].some((text) =>
        logLines(text).some((line) => item.done.test(line)),
      ),
    'finish starting',
  )
  const startup = {
    stdout: logLines(gateway.output()),
    stderr: logLines(gateway.errors()),
  }
  const answer = await item.exercise(t, gateway, port)
  await gateway.dispose()
  return { startup, answer }
}

for (const item of cases) {
  test(
    `--config from --printConfig runs as the command line: ${item.name}`,
    { timeout: gatewayTimeout(45000) },
    async (t) => {
      let upstreamPort = 0
      if (item.upstream) {
        upstreamPort = await unusedPort()
        const upstream = launchGateway(t, [
          '--stdio',
          peerCommand,
          '--port',
          String(upstreamPort),
          ...item.upstream,
        ])
        await upstream.ready()
      }
      const port = await unusedPort()
      const args = item.args(port, upstreamPort)
      const direct = await observe(t, item, args, port)

      const printer = launchGateway(t, [...args, '--printConfig'])
      const exit = await Promise.race([
        printer.exited,
        delay(requestTimeout(10000), 'still running' as const, {
          ref: false,
        }),
      ])
      assert.notEqual(exit, 'still running', '--printConfig exits')
      await Promise.all([
        ended(printer.child.stdout),
        ended(printer.child.stderr),
      ])
      assert.deepEqual(exit, { code: 0, signal: null })
      const dir = mkdtempSync(join(tmpdir(), 'sg-parity-'))
      t.after(() => rmSync(dir, { recursive: true, force: true }))
      const file = join(dir, 'config.json')
      writeFileSync(file, printer.output())
      assert.doesNotMatch(printer.output(), /<redacted>/)

      const viaConfig = await observe(t, item, ['--config', file], port)
      assert.deepEqual(
        viaConfig.startup,
        direct.startup,
        'the same startup log, line for line',
      )
      assert.deepEqual(viaConfig.answer, direct.answer, 'the same answer')
    },
  )
}
