import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  gatewayTimeout,
  initialize,
  launchGateway,
  peerCommand,
  requestTimeout,
  rpc,
  unusedPort,
} from './helpers/gateway-process.js'
import { lifecycleControl, pendingRpc } from './helpers/lifecycle-control.js'

// What the operator of a stateful Streamable HTTP gateway sees when a client
// goes away mid-exchange: a reply the server sends after its caller left is
// reported, not silently dropped, and a GET stream the client drops stops the
// session's liveness pings rather than pinging a stream nobody reads.

const until = async (
  gateway: ReturnType<typeof launchGateway>,
  predicate: () => boolean,
  what: string,
  ms: number,
) => {
  const deadline = Date.now() + ms
  while (!predicate()) {
    assert.ok(
      Date.now() < deadline,
      `Gateway did not ${what}:\n${gateway.output()}\n${gateway.errors()}`,
    )
    await delay(50)
  }
}

test(
  'stateful HTTP reports a late reply it cannot deliver after its client disconnects',
  { timeout: gatewayTimeout(20000) },
  async (t) => {
    const control = await lifecycleControl(t)
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      control.peerCommand,
      '--outputTransport',
      'streamableHttp',
      '--stateful',
      '--port',
      String(port),
    ])
    await gateway.ready()
    const url = `http://127.0.0.1:${port}/mcp`
    const session = (await rpc(url, initialize())).response.headers.get(
      'mcp-session-id',
    )!
    assert.ok(session)
    const pending = pendingRpc(
      t,
      url,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'hold', arguments: {} },
      },
      session,
    )
    const held = await control.started
    pending.abort()
    assert.equal((await pending.settled).kind, 'error')
    await gateway.waitFor(
      () => gateway.output().includes(`Response closed ${session}`),
      'observe the aborted HTTP request',
    )
    const log = () => gateway.output() + gateway.errors()
    assert.equal(log().includes('Failed to send to StreamableHttp'), false)
    held.end('release')
    // map: undeliverable-reply-reported
    await gateway.waitFor(
      () => log().includes('Failed to send to StreamableHttp'),
      'report the reply it could not deliver',
    )
    // The SDK names the request whose caller is gone.
    assert.match(
      log(),
      /Failed to send to StreamableHttp[^\n]*\n?[^\n]*request ID: 2/,
    )
    // map: session-survives
    const next = await rpc(
      url,
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      session,
    )
    assert.equal(next.response.status, 200)
    assert.equal(next.messages.find((message) => message.id === 3)?.id, 3)
  },
)

test(
  'a stateful GET stream the client drops stops its session’s liveness pings',
  { timeout: gatewayTimeout(30000) },
  async (t) => {
    const port = await unusedPort()
    // The first ping is due five seconds after a GET opens; the idle session
    // expires ten seconds after its last response ends. A probe still running
    // after its GET is gone would ping well before the expiry.
    const gateway = launchGateway(t, [
      '--stdio',
      peerCommand,
      '--outputTransport',
      'streamableHttp',
      '--stateful',
      '--sessionTimeout',
      '10000',
      '--port',
      String(port),
    ])
    await gateway.ready()
    const url = `http://127.0.0.1:${port}/mcp`
    const session = (await rpc(url, initialize())).response.headers.get(
      'mcp-session-id',
    )!
    assert.ok(session)
    const abort = new AbortController()
    t.after(() => abort.abort())
    const stream = await fetch(url, {
      headers: { accept: 'text/event-stream', 'mcp-session-id': session },
      signal: AbortSignal.any([
        abort.signal,
        AbortSignal.timeout(requestTimeout(5000)),
      ]),
    })
    assert.equal(stream.status, 200)
    void stream.text().catch(() => {})
    abort.abort()
    await gateway.waitFor(
      () => gateway.output().includes(`GET response closed`),
      'observe the dropped GET stream',
    )
    await until(
      gateway,
      () =>
        gateway.output().includes(`Session ${session} timed out, cleaning up`),
      'expire the idle session',
      requestTimeout(20000),
    )
    // map: dropped-get-stops-probe
    assert.equal(
      gateway.output().includes('Sending session liveness ping'),
      false,
      'no ping is sent once the GET that owned the probe has closed',
    )
    // map: expired-session
    const expired = await rpc(
      url,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      session,
    )
    assert.equal(expired.response.status, 404)
  },
)
