import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import {
  initialize,
  launchGateway,
  peerCommand,
  rpc,
  unusedPort,
} from './helpers/gateway-process.js'

// The MCP Streamable HTTP spec separates two cases that this gateway used to
// collapse into one 400:
//
//   "Servers that require a session ID SHOULD respond to requests without an
//    Mcp-Session-Id header (other than initialization) with HTTP 400 Bad
//    Request."
//   "The server MAY terminate the session at any time, after which it MUST
//    respond to requests containing that session ID with HTTP 404 Not Found.
//    When a client receives HTTP 404 in response to a request containing an
//    Mcp-Session-Id, it MUST start a new session by sending a new
//    InitializeRequest without a session ID attached."
//
// The 404 is the only signal a compliant client gets that it should
// re-initialize. Answering 400 for a dead session leaves it replaying an id
// the gateway will never honour again — which is what a client sees after
// --sessionTimeout reaps an idle session, after an explicit DELETE, or across
// a gateway restart.
const start = async (t: TestContext) => {
  const port = await unusedPort()
  const gateway = launchGateway(t, [
    '--stdio',
    peerCommand,
    '--outputTransport',
    'streamableHttp',
    '--stateful',
    '--sessionTimeout',
    '300',
    '--port',
    String(port),
  ])
  await gateway.ready()
  return { gateway, url: `http://127.0.0.1:${port}/mcp` }
}

const bare = (url: string, method: string, session?: string) =>
  fetch(url, {
    method,
    signal: AbortSignal.timeout(5000),
    headers: {
      accept: 'application/json, text/event-stream',
      ...(session ? { 'mcp-session-id': session } : {}),
    },
  })

test(
  'an idle-expired session is 404 on every method, and the client can re-initialize',
  { timeout: 30000 },
  async (t) => {
    const { url } = await start(t)
    const opened = await rpc(url, initialize())
    const session = opened.response.headers.get('mcp-session-id')!
    assert.ok(session)
    assert.equal(
      (await rpc(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, session))
        .response.status,
      200,
      'the session works while it is live',
    )

    // --sessionTimeout 300 reaps it: a server-side termination, the exact
    // case the spec's MUST covers.
    await delay(1200)

    const expired = await rpc(
      url,
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      session,
    )
    assert.equal(expired.response.status, 404)
    assert.deepEqual(expired.messages[0], {
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Session not found' },
      id: null,
    })

    for (const method of ['GET', 'DELETE']) {
      const response = await bare(url, method, session)
      assert.equal(
        response.status,
        404,
        `${method} on an expired session must be 404`,
      )
      assert.equal(await response.text(), 'Session not found')
    }

    // The point of the 404: the client drops the dead id and opens a new
    // session, which is what a compliant client does on receiving it.
    const fresh = await rpc(url, initialize(4))
    assert.equal(fresh.response.status, 200)
    const renewed = fresh.response.headers.get('mcp-session-id')!
    assert.ok(renewed)
    assert.notEqual(renewed, session)
    assert.equal(
      (await rpc(url, { jsonrpc: '2.0', id: 5, method: 'tools/list' }, renewed))
        .response.status,
      200,
      'the renewed session serves requests',
    )
  },
)

test(
  'an explicitly deleted session is 404, while a missing header stays 400',
  { timeout: 30000 },
  async (t) => {
    const { url } = await start(t)
    const session = (await rpc(url, initialize())).response.headers.get(
      'mcp-session-id',
    )!
    assert.ok(session)
    const deleted = await bare(url, 'DELETE', session)
    assert.equal(deleted.status, 200)
    await deleted.text()

    const afterDelete = await rpc(
      url,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      session,
    )
    assert.equal(afterDelete.response.status, 404)
    assert.equal(afterDelete.messages[0].error.code, -32001)

    // A session id the gateway has never held is indistinguishable from one
    // it lost across a restart, so it gets the same answer.
    const never = await rpc(
      url,
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      '00000000-0000-4000-8000-000000000000',
    )
    assert.equal(never.response.status, 404)
    assert.equal(never.messages[0].error.code, -32001)

    // No header at all is a different fault and keeps its 400: there is no
    // session to re-initialize away from, and the spec asks for 400 here.
    const missing = await rpc(url, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/list',
    })
    assert.equal(missing.response.status, 400)
    assert.deepEqual(missing.messages[0], {
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Bad Request: No valid session ID provided',
      },
      id: null,
    })

    for (const method of ['GET', 'DELETE']) {
      const response = await bare(url, method)
      assert.equal(
        response.status,
        400,
        `${method} without a session header must stay 400`,
      )
      assert.equal(await response.text(), 'Invalid or missing session ID')
    }
  },
)
