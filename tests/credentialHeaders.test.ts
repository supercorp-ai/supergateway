import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { knownBugTest } from './helpers/known-bug.js'
import { launchGateway, unusedPort } from './helpers/gateway-process.js'

/**
 * What `--header` and `--oauth2Bearer` actually do, measured against an upstream
 * that records what it was sent.
 *
 * Two findings from one line of code, in opposite directions. Every gateway
 * logs its configured headers at startup, and they do it two ways:
 *
 *     sseToStdio.ts, streamableHttpToStdio.ts
 *       Object.keys(headers).length  -> correct, so it prints them
 *     stdioToSse.ts, stdioToStateful*.ts, stdioToStateless*.ts
 *       Object(headers).length       -> always undefined, so it prints "(none)"
 *
 * `Object({ a: 1 }).length` is `undefined`, always falsy. That missing `.keys`
 * is GW-006 — three gateways report configured headers as absent.
 *
 * And the two that get it right print the value, so `--oauth2Bearer` puts the
 * token verbatim into the startup log at the default log level (GW-029). In a
 * container that goes straight to the platform's log store, and from there into
 * bug reports and CI output.
 *
 * One change fixes both: use `Object.keys` everywhere, and redact the value of
 * anything credential-shaped while printing the names.
 */
function recordingUpstream() {
  const requests: Array<Record<string, string | string[] | undefined>> = []
  const server = createServer((req, res) => {
    requests.push(req.headers)
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      let message: { method?: string; id?: unknown } | null = null
      try {
        message = JSON.parse(body)
      } catch {
        message = null
      }
      if (message?.method === 'initialize') {
        res.writeHead(200, {
          'content-type': 'application/json',
          'mcp-session-id': 'upstream-1',
        })
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              serverInfo: { name: 'upstream', version: '1.0.0' },
            },
          }),
        )
      } else if (message && message.id !== undefined) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }))
      } else {
        res.writeHead(202)
        res.end()
      }
    })
  })
  return { server, requests }
}

const TOKEN = 'secret-token-abc'

async function bridgeWithCredentials(t: Parameters<typeof launchGateway>[0]) {
  const { server, requests } = recordingUpstream()
  const upstreamPort = await unusedPort()
  await new Promise<void>((resolve) =>
    server.listen(upstreamPort, '127.0.0.1', resolve),
  )
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))

  const gateway = launchGateway(t, [
    '--streamableHttp',
    `http://127.0.0.1:${upstreamPort}/mcp`,
    '--outputTransport',
    'stdio',
    '--header',
    'x-user-id: 123',
    '--oauth2Bearer',
    TOKEN,
  ])
  gateway.child.stdin!.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'headers', version: '1.0.0' },
      },
    }) + '\n',
  )
  await gateway.waitFor(() => requests.length > 0, 'reach the upstream')
  return { gateway, requests }
}

test(
  'configured headers and the bearer token reach the upstream',
  { timeout: 30000 },
  async (t) => {
    const { requests } = await bridgeWithCredentials(t)
    assert.equal(requests[0]['x-user-id'], '123')
    assert.equal(requests[0]['authorization'], `Bearer ${TOKEN}`)
  },
)

/**
 * GW-029. The credential is in the startup log, in full, at the default log
 * level:
 *
 *     [supergateway]   - Headers: {"x-user-id":"123","Authorization":"Bearer secret-token-abc"}
 *
 * The header *names* are useful to log — that is what GW-006 is about failing to
 * do. The values of credential headers are not.
 */
knownBugTest(
  'GW-029',
  'the bearer token is not written to the log',
  { timeout: 30000 },
  async (t) => {
    const { gateway } = await bridgeWithCredentials(
      t as unknown as Parameters<typeof launchGateway>[0],
    )
    const log = gateway.output() + gateway.errors()
    assert.equal(
      log.includes(TOKEN),
      false,
      `the token appears in the gateway's own log:\n${log
        .split('\n')
        .filter((line) => line.includes(TOKEN))
        .join('\n')}`,
    )
    assert.match(
      log,
      /x-user-id/,
      'the header names should still be reported — that half is useful',
    )
  },
)
