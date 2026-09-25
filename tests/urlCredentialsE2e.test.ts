import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { initialize, launchGateway } from './helpers/gateway-process.js'

const PASSWORD = 'PASSW0RD9',
  TOKEN = 'QTOKEN123',
  HEADER = 'HDRSECRET7'

async function rejectingUpstream(t: Parameters<typeof launchGateway>[0]) {
  const seen: { url: string; headers: IncomingHttpHeaders }[] = []
  const server = createServer((req, res) => {
    seen.push({ url: req.url!, headers: req.headers })
    req.resume()
    res.writeHead(401).end('unauthorized')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return { seen, port: (server.address() as { port: number }).port }
}

for (const mode of ['sse', 'streamableHttp'] as const) {
  const path = mode === 'sse' ? 'sse' : 'mcp'

  // A query token and a header both still reach the upstream; neither may be
  // printed, to the log or to the stdio client.
  test(`${mode} bridge never prints a query token or a header value`, async (t) => {
    const upstream = await rejectingUpstream(t)
    const bridge = launchGateway(t, [
      `--${mode}`,
      `http://127.0.0.1:${upstream.port}/${path}?token=${TOKEN}`,
      '--header',
      `Authorization: Bearer ${HEADER}`,
    ])
    await bridge.ready()
    // The SSE bridge answers with an error; the Streamable HTTP bridge exits
    // because its first connection failed. Either way the attempt is over.
    bridge.child.stdin.write(JSON.stringify(initialize(1)) + '\n')
    await bridge.waitFor(
      () =>
        bridge.child.exitCode !== null || bridge.output().includes('"id":1'),
      'answer or exit after the rejected connection',
    )
    const printed = bridge.output() + bridge.errors()
    for (const secret of [TOKEN, HEADER])
      assert.equal(printed.includes(secret), false, `${secret} was printed`)
    assert.match(printed, /token=redacted/, 'the URL is printed, redacted')

    assert.ok(upstream.seen.length > 0, 'the bridge reached the upstream')
    assert.equal(upstream.seen[0].headers.authorization, `Bearer ${HEADER}`)
    assert.ok(
      upstream.seen[0].url.includes(`token=${TOKEN}`),
      'the query is still sent upstream',
    )
  })

  // fetch refuses a URL with a user and password and quotes it whole in the
  // error, so such a URL never connected and printed its password instead.
  test(`${mode} bridge refuses URL credentials at startup without printing them`, async (t) => {
    const upstream = await rejectingUpstream(t)
    const bridge = launchGateway(t, [
      `--${mode}`,
      `http://user:${PASSWORD}@127.0.0.1:${upstream.port}/${path}`,
    ])
    // Bounded: a bridge that keeps running must fail this test, not hang it.
    await bridge.waitFor(
      () => bridge.child.exitCode !== null,
      'exit on URL credentials',
    )
    assert.equal(bridge.child.exitCode, 1)
    const printed = bridge.output() + bridge.errors()
    assert.match(printed, /Credentials in the upstream URL are not supported/)
    assert.match(printed, /--header "Authorization: Basic/)
    assert.equal(printed.includes(PASSWORD), false, 'the password was printed')
    assert.deepEqual(upstream.seen, [], 'nothing was sent upstream')
  })
}
