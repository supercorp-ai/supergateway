import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { launchGateway, unusedPort } from './helpers/gateway-process.js'

/**
 * What `--header` and `--oauth2Bearer` actually do, measured against an upstream
 * that records what it was sent.
 *
 * Two findings came from one line of code, in opposite directions. Every gateway
 * logged its configured headers at startup, and did it two ways:
 *
 *     sseToStdio.ts, streamableHttpToStdio.ts
 *       Object.keys(headers).length  -> correct, so it printed them
 *     stdioToSse.ts, stdioToStateful*.ts, stdioToStateless*.ts
 *       Object(headers).length       -> always undefined, so it printed "(none)"
 *
 * `Object({ a: 1 }).length` is `undefined`, always falsy. That missing `.keys`
 * was GW-006 — three gateways reporting configured headers as absent.
 *
 * And the two that got it right printed the value, so `--oauth2Bearer` put the
 * token verbatim into the startup log at the default log level (GW-029). In a
 * container that goes straight to the platform's log store, and from there into
 * bug reports and CI output.
 *
 * Both are fixed by `describeHeaders`: `Object.keys` everywhere, header names
 * printed, credential-shaped values redacted. `headerDiagnosticsE2e.test.ts`
 * holds the GW-006 half; this file holds the disclosure half, and asserts that
 * forwarding is untouched — the fix is to the log line only, and a redaction
 * that reached the wire would break every authenticated deployment.
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
 * GW-029, fixed. What used to be logged, in full, at the default level:
 *
 *     [supergateway]   - Headers: {"x-user-id":"123","Authorization":"Bearer secret-token-abc"}
 *
 * The header *names* are worth logging — failing to do that is GW-006. The
 * values of credential headers are not.
 */
test(
  'the bearer token is not written to the log',
  { timeout: 30000 },
  async (t) => {
    const { gateway } = await bridgeWithCredentials(t)
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
      /"x-user-id":"123"/,
      'an ordinary header keeps its value — only credentials are redacted',
    )
    assert.match(
      log,
      /"Authorization":"<redacted>"/,
      'the credential header is still named, so the configuration is auditable',
    )
  },
)

/**
 * The second route to the same disclosure. `--header "Authorization Bearer abc"`
 * is a plausible typo — a space where a colon belongs — and the parser used to
 * answer by echoing the whole argument back:
 *
 *     Invalid header format: Authorization Bearer abc, ignoring
 *
 * Now it reports only the first token, which is the part that says *which*
 * argument was wrong.
 */
test(
  'a malformed header is reported without its value',
  { timeout: 30000 },
  async (t) => {
    const { server } = recordingUpstream()
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
      `Authorization Bearer ${TOKEN}`,
    ])
    await gateway.waitFor(
      () => /Invalid header format/.test(gateway.errors()),
      'reject the malformed header',
    )
    const log = gateway.output() + gateway.errors()
    assert.equal(
      log.includes(TOKEN),
      false,
      `the token appears in the rejection message:\n${log}`,
    )
    assert.match(log, /Invalid header format: Authorization, ignoring/)
  },
)
