import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
// The `ws` client, not the global one: `WebSocket` is undefined on Node 20.
import { WebSocket } from 'ws'
import {
  gatewayTimeout,
  initialize,
  launchGateway,
  peerCommand,
  requestTimeout,
  rpc,
  unusedPort,
} from './helpers/gateway-process.js'

// `--host` end to end, against the built CLI: where each listening gateway
// accepts connections, what its startup listing says, and where the flag is
// refused. Unset, nothing may change, down to the byte: deployments and
// downstream tools (langchain-mcp-tools waits for `Listening on port`) read
// these lines.

const prefix = '[supergateway] '
const banner =
  'Supergateway is supported by Supercov - Coverage for coding agents and software factories 🌙 - https://supercov.com'

// A non-loopback IPv4 address of this machine, if it has one: the address a
// loopback-bound gateway must refuse and a default gateway must accept.
const lanAddress = Object.values(os.networkInterfaces())
  .flat()
  .find((address) => address?.family === 'IPv4' && !address.internal)?.address
const noLan = lanAddress
  ? false
  : 'this machine has no non-loopback IPv4 address to connect through'

// Whether IPv6 loopback can be bound here at all. Some containers have none.
const ipv6Loopback = await new Promise<boolean>((resolve) => {
  const server = net.createServer()
  server.once('error', () => resolve(false))
  server.listen(0, '::1', () => server.close(() => resolve(true)))
})
const noIpv6 = ipv6Loopback ? false : 'IPv6 loopback (::1) is not available'

// An address in no subnet this machine owns, so binding it fails with
// EADDRNOTAVAIL rather than succeeding.
const unbindable = '10.255.255.1'
const unbindableIsLocal = Object.values(os.networkInterfaces())
  .flat()
  .some((address) => address?.address === unbindable)

// How a client writes an address in a URL.
const urlHost = (address: string) =>
  address.includes(':') ? `[${address}]` : address

type Mode = {
  name: string
  args: string[]
  // The whole startup output with `--host` unset, as main prints it today.
  listing: (port: number) => string[]
  // Its endpoint lines, for a given endpoint host.
  endpoints: (host: string, port: number) => string[]
  // Completes an MCP initialize through the gateway at that address.
  reach: (t: TestContext, address: string, port: number) => Promise<void>
}

const reachHttp = async (_t: TestContext, address: string, port: number) => {
  const { response, messages } = await rpc(
    `http://${urlHost(address)}:${port}/mcp`,
    initialize(),
  )
  assert.equal(response.status, 200)
  assert.equal(messages[0].result.serverInfo.name, 'mock-server')
}

const modes: Mode[] = [
  {
    name: 'stdio→SSE',
    args: [],
    listing: (port) => [
      'Starting...',
      banner,
      '  - outputTransport: sse',
      '  - Headers: (none)',
      `  - port: ${port}`,
      `  - stdio: ${peerCommand}`,
      '  - ssePath: /sse',
      '  - messagePath: /message',
      '  - CORS: disabled',
      '  - Health endpoints: (none)',
      `Listening on port ${port}`,
      `SSE endpoint: http://localhost:${port}/sse`,
      `POST messages: http://localhost:${port}/message`,
    ],
    endpoints: (host, port) => [
      `SSE endpoint: http://${host}:${port}/sse`,
      `POST messages: http://${host}:${port}/message`,
    ],
    // The endpoint event is the SSE handshake; the session's own Server
    // sends it.
    reach: (t, address, port) =>
      new Promise<void>((resolve, reject) => {
        const req = http.get(
          {
            host: address,
            port,
            path: '/sse',
            headers: { accept: 'text/event-stream' },
            signal: AbortSignal.timeout(requestTimeout(5000)),
          },
          (res) => {
            let received = ''
            res.setEncoding('utf8').on('data', (chunk: string) => {
              received += chunk
              if (!received.includes('\n\n')) return
              req.destroy()
              try {
                assert.equal(res.statusCode, 200)
                assert.match(received, /^event: endpoint$/m)
                resolve()
              } catch (error) {
                reject(error)
              }
            })
          },
        )
        req.on('error', (error) => {
          if (!req.destroyed) reject(error)
        })
        t.after(() => req.destroy())
      }),
  },
  {
    name: 'stdio→WS',
    args: ['--outputTransport', 'ws'],
    listing: (port) => [
      'Starting...',
      banner,
      '  - outputTransport: ws',
      `  - port: ${port}`,
      `  - stdio: ${peerCommand}`,
      '  - messagePath: /message',
      '  - CORS: disabled',
      '  - Health endpoints: (none)',
      `Listening on port ${port}`,
      `WebSocket endpoint: ws://localhost:${port}/message`,
    ],
    endpoints: (host, port) => [
      `WebSocket endpoint: ws://${host}:${port}/message`,
    ],
    reach: async (t, address, port) => {
      const socket = new WebSocket(`ws://${urlHost(address)}:${port}/message`)
      t.after(() => socket.terminate())
      await once(socket, 'open')
      const reply = once(socket, 'message')
      socket.send(JSON.stringify(initialize()))
      assert.equal(
        JSON.parse(String((await reply)[0])).result.serverInfo.name,
        'mock-server',
      )
      socket.terminate()
    },
  },
  {
    name: 'stateless stdio→Streamable HTTP',
    args: ['--outputTransport', 'streamableHttp'],
    listing: (port) => [
      'Starting...',
      banner,
      '  - outputTransport: streamableHttp',
      'Running stateless server',
      '  - Headers: (none)',
      `  - port: ${port}`,
      `  - stdio: ${peerCommand}`,
      '  - streamableHttpPath: /mcp',
      '  - protocolVersion: 2024-11-05',
      '  - CORS: disabled',
      '  - Health endpoints: (none)',
      `Listening on port ${port}`,
      `StreamableHttp endpoint: http://localhost:${port}/mcp`,
    ],
    endpoints: (host, port) => [
      `StreamableHttp endpoint: http://${host}:${port}/mcp`,
    ],
    reach: reachHttp,
  },
  {
    name: 'stateful stdio→Streamable HTTP',
    args: ['--outputTransport', 'streamableHttp', '--stateful'],
    listing: (port) => [
      'Starting...',
      banner,
      '  - outputTransport: streamableHttp',
      'Running stateful server',
      '  - Headers: (none)',
      `  - port: ${port}`,
      `  - stdio: ${peerCommand}`,
      '  - streamableHttpPath: /mcp',
      '  - CORS: disabled',
      '  - Health endpoints: (none)',
      '  - Session timeout: 1800000ms',
      `Listening on port ${port}`,
      `StreamableHttp endpoint: http://localhost:${port}/mcp`,
    ],
    endpoints: (host, port) => [
      `StreamableHttp endpoint: http://${host}:${port}/mcp`,
    ],
    reach: reachHttp,
  },
]

// The listing a gateway prints with `--host`: the host line straight after
// the port line, and the endpoint lines naming `endpointHost`.
const listingWithHost = (
  mode: Mode,
  port: number,
  host: string,
  endpointHost: string,
) => {
  const lines = mode.listing(port)
  const unset = mode.endpoints('localhost', port)
  const withHost = lines.flatMap((line) =>
    line === `  - port: ${port}` ? [line, `  - host: ${host}`] : [line],
  )
  return [
    ...withHost.slice(0, withHost.length - unset.length),
    ...mode.endpoints(endpointHost, port),
  ]
}

// Start a gateway in `mode`, wait for its last startup line, and return what
// it printed, one entry per line without the prefix.
async function start(t: TestContext, mode: Mode, extra: string[]) {
  const port = await unusedPort()
  const gateway = launchGateway(t, [
    '--stdio',
    peerCommand,
    ...mode.args,
    '--port',
    String(port),
    ...extra,
  ])
  await gateway.ready()
  // The endpoint lines follow the ready line, possibly in a later chunk. Wait
  // for the whole of the last one, e.g. `POST messages: …\n`.
  const lastLine = mode.endpoints('localhost', port).at(-1)!
  const last = lastLine.slice(0, lastLine.indexOf(': ') + 1)
  await gateway.waitFor(() => {
    const output = gateway.output()
    const at = output.indexOf(last)
    return at >= 0 && output.indexOf('\n', at) >= 0
  }, 'finish announcing its endpoints')
  const lines = gateway
    .output()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) =>
      line.startsWith(prefix) ? line.slice(prefix.length) : `(raw) ${line}`,
    )
  return { gateway, port, lines }
}

// Whether a plain TCP connection to the address is accepted. Refused means
// nothing listens on that address and port; anything else is a test error.
const connects = (address: string, port: number) =>
  new Promise<boolean>((resolve, reject) => {
    const socket = net.connect({ host: address, port })
    socket.setTimeout(requestTimeout(5000), () =>
      socket.destroy(Error(`connecting to ${address}:${port} timed out`)),
    )
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', (error: NodeJS.ErrnoException) =>
      error.code === 'ECONNREFUSED' ? resolve(false) : reject(error),
    )
  })

// How a gateway expected to stop by itself ended, or `still running` once a
// generous budget has passed: a build that ignores the flag never exits.
const exitOf = (gateway: ReturnType<typeof launchGateway>) =>
  Promise.race([
    gateway.exited,
    delay(requestTimeout(10000), 'still running', { ref: false }),
  ])

for (const mode of modes) {
  test(
    `${mode.name} without --host listens on every interface and prints what it always has`,
    { timeout: gatewayTimeout(20000) },
    async (t) => {
      const { port, lines } = await start(t, mode, [])
      assert.deepEqual(
        lines,
        mode.listing(port),
        'the startup output is unchanged: no host line, localhost endpoints',
      )
      await mode.reach(t, '127.0.0.1', port)
      await t.test(
        'it is reachable on a non-loopback address too',
        { skip: noLan },
        async (t) => {
          await mode.reach(t, lanAddress!, port)
        },
      )
    },
  )

  test(
    `${mode.name} with --host 127.0.0.1 listens on loopback only`,
    { timeout: gatewayTimeout(20000) },
    async (t) => {
      const { port, lines } = await start(t, mode, ['--host', '127.0.0.1'])
      await mode.reach(t, '127.0.0.1', port)
      await t.test(
        'it is not reachable on a non-loopback address',
        { skip: noLan },
        async () => {
          assert.equal(
            await connects(lanAddress!, port),
            false,
            `nothing accepts connections on ${lanAddress}:${port}`,
          )
        },
      )
      assert.deepEqual(
        lines,
        listingWithHost(mode, port, '127.0.0.1', '127.0.0.1'),
        'the host is listed after the port, and the endpoints name it',
      )
    },
  )

  for (const spelling of ['::1', '[::1]'])
    test(
      `${mode.name} with --host ${spelling} listens on IPv6 loopback only`,
      { timeout: gatewayTimeout(20000), skip: noIpv6 },
      async (t) => {
        const { port, lines } = await start(t, mode, ['--host', spelling])
        await mode.reach(t, '::1', port)
        assert.equal(
          await connects('127.0.0.1', port),
          false,
          'IPv4 loopback is not listening, so the gateway bound ::1 alone',
        )
        assert.deepEqual(
          lines,
          listingWithHost(mode, port, '::1', '[::1]'),
          'the host is listed without brackets, and the endpoints bracket it',
        )
      },
    )

  for (const wildcard of ['0.0.0.0', '::'])
    test(
      `${mode.name} with --host ${wildcard} keeps localhost in its endpoints`,
      {
        timeout: gatewayTimeout(20000),
        skip: wildcard === '::' ? noIpv6 : false,
      },
      async (t) => {
        const { port, lines } = await start(t, mode, ['--host', wildcard])
        assert.deepEqual(
          lines,
          listingWithHost(mode, port, wildcard, 'localhost'),
          'the host is listed, but a client cannot connect to a wildcard address',
        )
        await mode.reach(t, '127.0.0.1', port)
      },
    )

  test(
    `${mode.name} fails on an address it cannot bind as it does on a port in use`,
    {
      timeout: gatewayTimeout(20000),
      skip: unbindableIsLocal && `${unbindable} is an address of this machine`,
    },
    async (t) => {
      // How a listen failure ends today, with no --host: Node's unhandled
      // 'error' event, its stack on stderr, and exit code 1.
      const failure = async (extra: string[], port: number) => {
        const gateway = launchGateway(t, [
          '--stdio',
          peerCommand,
          ...mode.args,
          '--port',
          String(port),
          ...extra,
        ])
        const exit = await exitOf(gateway)
        const errors = gateway.errors()
        return {
          exit,
          unhandled: errors.includes("throw er; // Unhandled 'error' event"),
          error: errors.match(/^Error: listen (E[A-Z]+): /m)?.[1],
          listening: gateway.output().includes('Listening on port'),
        }
      }
      const occupied = net.createServer()
      const port = await unusedPort()
      await new Promise<void>((resolve) => occupied.listen(port, resolve))
      t.after(() => occupied.close())
      const inUse = await failure([], port)
      assert.deepEqual(inUse, {
        exit: { code: 1, signal: null },
        unhandled: true,
        error: 'EADDRINUSE',
        listening: false,
      })
      const notAvailable = await failure(
        ['--host', unbindable],
        await unusedPort(),
      )
      assert.deepEqual(
        notAvailable,
        { ...inUse, error: 'EADDRNOTAVAIL' },
        'an unbindable address fails exactly as a port in use does',
      )
    },
  )
}

for (const bridge of [
  { flag: '--sse', url: 'http://127.0.0.1:54321/events', starts: 'SSE' },
  {
    flag: '--streamableHttp',
    url: 'http://127.0.0.1:54321/mcp',
    starts: 'Streamable HTTP',
  },
])
  test(
    `${bridge.flag} refuses --host, which it could not honour`,
    { timeout: gatewayTimeout(15000) },
    async (t) => {
      const refused = launchGateway(t, [
        bridge.flag,
        bridge.url,
        '--host',
        '127.0.0.1',
      ])
      assert.deepEqual(await exitOf(refused), { code: 1, signal: null })
      assert.equal(
        refused.errors(),
        `${prefix}Error: --host applies only when supergateway listens (stdio→SSE, stdio→WS or stdio→Streamable HTTP)\n`,
      )
      assert.equal(refused.output(), '', 'nothing reaches the stdio client')
      // The same bridge without --host still starts.
      const control = launchGateway(t, [bridge.flag, bridge.url])
      await control.waitFor(
        () => control.errors().includes(`Connecting to ${bridge.starts}...`),
        'start connecting',
      )
      assert.equal(control.child.exitCode, null)
    },
  )

for (const empty of ['', '[]'])
  test(
    `--host ${JSON.stringify(empty)} is refused rather than read as every interface`,
    { timeout: gatewayTimeout(15000) },
    async (t) => {
      const gateway = launchGateway(t, [
        '--stdio',
        peerCommand,
        '--port',
        String(await unusedPort()),
        '--host',
        empty,
      ])
      assert.deepEqual(await exitOf(gateway), { code: 1, signal: null })
      assert.equal(
        gateway.errors(),
        `${prefix}Error: --host needs an address, e.g. 127.0.0.1 or ::1\n`,
      )
      assert.equal(gateway.output(), '')
    },
  )
