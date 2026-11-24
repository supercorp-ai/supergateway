import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { request, type IncomingMessage } from 'node:http'
import os from 'node:os'
import { WebSocket } from 'ws'
import {
  gatewayTimeout,
  initialize,
  launchGateway,
  peerCommand,
  requestTimeout,
  unusedPort,
} from './helpers/gateway-process.js'

/**
 * The browser checks of browserGuard.ts, end to end, on every output.
 *
 * DNS rebinding: a page at a name of its own that now points at this machine
 * asks the gateway same-origin, so its browser sends that name as `Host` and
 * `Sec-Fetch-Site: same-origin`. Here the client sends what that browser
 * would. Everything that is not that request (clients that aren't browsers,
 * tunnels forwarding a public Host, other machines, a key) is served as
 * before.
 */

const options = { timeout: gatewayTimeout(60000) }

const lanAddress = Object.values(os.networkInterfaces())
  .flat()
  .find((net) => net && net.family === 'IPv4' && !net.internal)?.address
const noLan = lanAddress ? false : 'no non-loopback IPv4 interface'

const outputs = {
  SSE: { args: ['--outputTransport', 'sse'], path: '/sse', method: 'GET' },
  'stateless Streamable HTTP': {
    args: ['--outputTransport', 'streamableHttp'],
    path: '/mcp',
    method: 'POST',
  },
  'stateful Streamable HTTP': {
    args: ['--outputTransport', 'streamableHttp', '--stateful'],
    path: '/mcp',
    method: 'POST',
  },
  WS: { args: ['--outputTransport', 'ws'], path: '/healthz', method: 'GET' },
} as const

const start = async (t: TestContext, args: string[]) => {
  const port = await unusedPort()
  const gateway = launchGateway(t, [
    '--stdio',
    peerCommand,
    '--port',
    String(port),
    '--healthEndpoint',
    '/healthz',
    ...args,
  ])
  await gateway.ready()
  return { port, gateway }
}

// One HTTP request with exactly these headers; the status, and the body
// unless it is an SSE stream, which is closed once its headers arrive.
const ask = (
  port: number,
  { path, method }: { path: string; method: string },
  headers: Record<string, string>,
  address = '127.0.0.1',
) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        host: address,
        port,
        path,
        method,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers,
        },
        timeout: requestTimeout(10000),
      },
      (res: IncomingMessage) => {
        if (res.headers['content-type']?.startsWith('text/event-stream')) {
          res.destroy()
          return resolve({ status: res.statusCode!, body: '' })
        }
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode!, body }))
      },
    )
    req.on('timeout', () => req.destroy(Error('no answer')))
    req.on('error', reject)
    req.end(method === 'POST' ? JSON.stringify(initialize(1)) : undefined)
  })

const rebinding = (port: number) => ({
  host: `evil.test:${port}`,
  'sec-fetch-site': 'same-origin',
})
const refusal =
  '{"jsonrpc":"2.0","error":{"code":-32001,"message":"Forbidden: host not allowed"},"id":null}'

for (const [name, output] of Object.entries(outputs)) {
  test(
    `${name}: a DNS rebinding request is refused, once logged; everything else is served`,
    options,
    async (t) => {
      const { port, gateway } = await start(t, [...output.args])
      for (let i = 0; i < 2; i++)
        assert.deepEqual(await ask(port, output, rebinding(port)), {
          status: 403,
          body: refusal,
        })
      // Told by Origin alone too, as a POST from a browser without Sec-Fetch-Site.
      assert.equal(
        (
          await ask(port, output, {
            host: `evil.test:${port}`,
            origin: `http://evil.test:${port}`,
          })
        ).status,
        403,
      )
      // A client that is not a browser, through a tunnel that forwards its Host.
      assert.equal(
        (await ask(port, output, { host: `abc.ngrok-free.app` })).status,
        200,
      )
      // A page on this machine's own name.
      assert.equal(
        (
          await ask(port, output, {
            host: `localhost:${port}`,
            'sec-fetch-site': 'same-origin',
          })
        ).status,
        200,
      )
      await gateway.waitFor(
        () =>
          gateway
            .output()
            .includes("Refused a web page's request for evil.test"),
        'the refusal to be logged',
      )
      assert.equal(
        gateway.output().split("Refused a web page's request for").length,
        2,
        'logged once',
      )
    },
  )

  test(
    `${name}: from another machine, the same request is served`,
    { ...options, skip: noLan },
    async (t) => {
      const { port } = await start(t, [...output.args])
      assert.equal(
        (await ask(port, output, rebinding(port), lanAddress)).status,
        200,
      )
    },
  )

  // WS's only plain-HTTP route is the health endpoint, open by design; its
  // upgrade with a key is checked below.
  test(
    `${name}: with an API key, the key decides instead`,
    { ...options, skip: name === 'WS' && 'its health endpoint is open' },
    async (t) => {
      const { port } = await start(t, [...output.args, '--apiKey', 'k1'])
      // A page can't supply the key: without it 401, as before; with it, served.
      assert.equal((await ask(port, output, rebinding(port))).status, 401)
      assert.equal(
        (
          await ask(port, output, {
            ...rebinding(port),
            authorization: 'Bearer k1',
          })
        ).status,
        200,
      )
    },
  )
}

test(
  '--cors listing the page origin lets a rebinding-shaped request through',
  options,
  async (t) => {
    const output = outputs['stateless Streamable HTTP']
    const { port } = await start(t, [
      ...output.args,
      '--cors',
      '/^http:\\/\\/mcp\\.example(:\\d+)?$/',
    ])
    assert.equal(
      (
        await ask(port, output, {
          host: `mcp.example:${port}`,
          'sec-fetch-site': 'same-origin',
        })
      ).status,
      200,
    )
    assert.equal((await ask(port, output, rebinding(port))).status, 403)
  },
)

test(
  'SSE: --baseUrl names the page the gateway is served for',
  options,
  async (t) => {
    const output = outputs.SSE
    const { port } = await start(t, [
      ...output.args,
      '--baseUrl',
      'https://mcp.example',
    ])
    assert.equal(
      (
        await ask(port, output, {
          host: 'mcp.example',
          'sec-fetch-site': 'same-origin',
        })
      ).status,
      200,
    )
    assert.equal((await ask(port, output, rebinding(port))).status, 403)
  },
)

// The first answer to a WebSocket upgrade: opened, or the refusal's status.
const upgrade = (
  port: number,
  headers: { origin?: string; host?: string },
  address = '127.0.0.1',
) =>
  new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(`ws://${address}:${port}/message`, {
      ...(headers.origin ? { origin: headers.origin } : {}),
      ...(headers.host ? { headers: { host: headers.host } } : {}),
    })
    const timer = setTimeout(
      () => reject(Error('no answer')),
      requestTimeout(10000),
    )
    ws.once('open', () => {
      clearTimeout(timer)
      ws.close()
      resolve(101)
    })
    ws.once('unexpected-response', (_req, res) => {
      clearTimeout(timer)
      res.resume()
      resolve(res.statusCode!)
    })
    ws.once('error', reject)
  })

test(
  'WS without --cors: a page on another site is refused on loopback, served from another machine',
  options,
  async (t) => {
    const { port, gateway } = await start(t, ['--outputTransport', 'ws'])
    assert.equal(await upgrade(port, { origin: 'https://evil.test' }), 403)
    assert.equal(await upgrade(port, {}), 101)
    assert.equal(await upgrade(port, { origin: 'http://localhost:3000' }), 101)
    assert.equal(await upgrade(port, { origin: 'chrome-extension://abc' }), 101)
    // Rebinding, on the upgrade itself.
    assert.equal(
      await upgrade(port, {
        origin: `http://evil.test:${port}`,
        host: `evil.test:${port}`,
      }),
      403,
    )
    if (lanAddress)
      assert.equal(
        await upgrade(port, { origin: 'https://evil.test' }, lanAddress),
        101,
      )
    await gateway.waitFor(
      () =>
        gateway
          .output()
          .includes(
            "Refused a WebSocket connection from https://evil.test: a web page on another site, on this machine's loopback address, and no --cors. Add --cors https://evil.test to allow it.",
          ),
      'the refusal to be logged',
    )
  },
)

test(
  'WS: --cors with that site, or an API key, lets it in',
  options,
  async (t) => {
    const { port: listed } = await start(t, [
      '--outputTransport',
      'ws',
      '--cors',
      'https://evil.test',
    ])
    assert.equal(await upgrade(listed, { origin: 'https://evil.test' }), 101)
    const { port: keyed } = await start(t, [
      '--outputTransport',
      'ws',
      '--apiKey',
      'k1',
    ])
    // A browser can't send the key's header, so without it, 401 as before.
    assert.equal(await upgrade(keyed, { origin: 'https://evil.test' }), 401)
  },
)
