import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  LoggingMessageNotificationSchema,
  ToolListChangedNotificationSchema,
  CreateMessageRequestSchema,
  ListRootsRequestSchema,
  ElicitRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { knownBugTest } from './helpers/known-bug.js'
import { launchGateway, unusedPort } from './helpers/gateway-process.js'

/**
 * The other direction.
 *
 * Every other test in this repository — and all five cross-client drivers —
 * is client-initiated: the client asks, the server answers. MCP is not
 * one-directional. A server sends log and progress notifications, announces
 * that its tool list changed, and makes *requests of its own*: `sampling/
 * createMessage` to borrow the client's model, `roots/list` to ask what it may
 * touch, `elicitation/create` to ask the user a question. All of that has to
 * cross the gateway backwards, and nothing was checking that it does.
 *
 * `reverse-peer.mjs` exercises all six from the server side.
 *
 * Result: stateful HTTP relays all six correctly. SSE relays five and loses
 * progress notifications after the first (GW-027). Stateless HTTP relays none
 * of them, and its two halves fail differently (GW-026) — notifications are
 * dropped, server-initiated requests hang.
 */
const MODES = [
  {
    label: 'stateful HTTP',
    args: ['--outputTransport', 'streamableHttp', '--stateful'],
    path: '/mcp',
    sse: false,
    works: true,
  },
  {
    label: 'SSE',
    args: ['--outputTransport', 'sse'],
    path: '/sse',
    sse: true,
    works: true,
  },
  {
    label: 'stateless HTTP',
    args: ['--outputTransport', 'streamableHttp'],
    path: '/mcp',
    sse: false,
    works: false,
  },
] as const

type Reply = { content: Array<{ type: string; text: string }> }

interface Observed {
  client: Client
  logs: string[]
  progress: number[]
  toolsChanged: () => number
}

async function connect(
  t: TestContext,
  mode: (typeof MODES)[number],
): Promise<Observed> {
  const port = await unusedPort()
  const gateway = launchGateway(t, [
    '--stdio',
    'node tests/helpers/reverse-peer.mjs',
    '--port',
    String(port),
    ...mode.args,
  ])
  await gateway.ready()
  const url = new URL(`http://127.0.0.1:${port}${mode.path}`)

  // The client has to advertise these, or the SDK refuses the server's request
  // before the gateway is ever involved and the test would prove nothing.
  const client = new Client(
    { name: 'reverse', version: '1.0.0' },
    {
      capabilities: {
        sampling: {},
        roots: { listChanged: true },
        elicitation: {},
      },
    },
  )
  const logs: string[] = []
  const progress: number[] = []
  let changed = 0
  client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
    logs.push(String(n.params.data))
  })
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    changed++
  })
  client.setRequestHandler(CreateMessageRequestSchema, async () => ({
    model: 'offline-stub',
    role: 'assistant',
    content: { type: 'text', text: 'pong' },
  }))
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: 'file:///tmp/root-a', name: 'a' }],
  }))
  client.setRequestHandler(ElicitRequestSchema, async () => ({
    action: 'accept' as const,
    content: { name: 'domas' },
  }))

  t.after(() => client.close().catch(() => {}))
  await client.connect(
    mode.sse
      ? new SSEClientTransport(url)
      : new StreamableHTTPClientTransport(url),
  )
  return { client, logs, progress, toolsChanged: () => changed }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 500))
const textOf = (reply: unknown) =>
  (reply as Reply).content?.find((c) => c.type === 'text')?.text ?? ''

async function progressSeenBy(o: Observed) {
  const seen: number[] = []
  const done = await o.client.callTool(
    { name: 'progress', arguments: {} },
    undefined,
    { onprogress: (p) => seen.push(p.progress) },
  )
  await settle()
  assert.match(
    textOf(done),
    /^progress-done/,
    'the progress tool itself failed',
  )
  return seen
}

async function assertReverseDirectionWorks(o: Observed) {
  const logged = await o.client.callTool({ name: 'log', arguments: {} })
  await settle()
  assert.equal(textOf(logged), 'logged')
  assert.deepEqual(
    o.logs,
    ['log-info', 'log-warning', 'log-error'],
    'logging notifications emitted during the call did not reach the client',
  )

  const before = o.toolsChanged()
  await o.client.callTool({ name: 'toolsChanged', arguments: {} })
  await settle()
  assert.ok(
    o.toolsChanged() > before,
    'the server announced a tool list change and the client never heard it',
  )

  // The three that are *requests* from the server, each needing a reply routed
  // back through the gateway to the peer that asked.
  for (const [tool, expected] of [
    ['sample', 'sampled:pong'],
    ['roots', 'roots:file:///tmp/root-a'],
    ['elicit', 'elicited:accept:domas'],
  ] as const) {
    const reply = await o.client.callTool({ name: tool, arguments: {} })
    assert.equal(
      textOf(reply),
      expected,
      `the server's own ${tool} request did not complete`,
    )
  }
}

for (const mode of MODES.filter((m) => m.works)) {
  test(
    `${mode.label}: notifications, sampling, roots and elicitation all cross backwards`,
    { timeout: 90000 },
    async (t) => {
      await assertReverseDirectionWorks(await connect(t, mode))
    },
  )
}

test(
  'stateful HTTP: every progress notification reaches the caller',
  { timeout: 90000 },
  async (t) => {
    const seen = await progressSeenBy(await connect(t, MODES[0]))
    assert.deepEqual(seen, [1, 2, 3])
  },
)

/**
 * GW-027. Under SSE the peer emits three progress notifications for one call
 * and the caller's `onprogress` fires **once**. Measured, repeatedly, against
 * the same peer and the same client code that gets all three over stateful
 * HTTP:
 *
 *     stateful  onprogress [1,2,3]   result progress-done token=1
 *     sse       onprogress [1]       result progress-done token=1
 *
 * I do not yet know where 2 and 3 are lost, and I am not going to guess: a
 * client that installs its own `notifications/progress` handler — which
 * replaces the SDK's internal one, so `onprogress` never fires at all — does
 * see all three arrive over SSE, which says the notifications reach the client
 * process. That narrows it without settling it, since that same override
 * changes the dispatch path being measured.
 *
 * What is certain is the user-visible effect: a long-running tool reports
 * progress once and then appears to stall, on the transport most likely to be
 * used for long-running tools.
 */
knownBugTest(
  'GW-027',
  'SSE: every progress notification reaches the caller',
  { timeout: 90000 },
  async (t) => {
    const seen = await progressSeenBy(await connect(t, MODES[1]))
    assert.deepEqual(seen, [1, 2, 3])
  },
)

const stateless = MODES.find((m) => !m.works)!

/**
 * GW-026, first half: notifications a server emits *while handling a request*
 * are dropped.
 *
 * The gateway itself is not at fault — it calls `transport.send` for every
 * message the child writes. The SDK's stateless transport then has nowhere to
 * put a message that is not the answer to a request: there is no session and no
 * standalone GET stream, so it silently discards it. Measured on the raw body —
 * the POST response is already `text/event-stream` and carries exactly one
 * event, the result.
 *
 * This one is fixable. The spec intends the POST's own SSE stream to carry
 * notifications ahead of the result, and in stateless mode there is exactly one
 * request in flight per child, so tagging child notifications with that
 * request's id is unambiguous.
 */
knownBugTest(
  'GW-026',
  `${stateless.label}: a notification emitted during a call reaches the client`,
  { timeout: 90000 },
  async (t) => {
    const o = await connect(t, stateless)
    const logged = await o.client.callTool({ name: 'log', arguments: {} })
    await settle()
    assert.equal(
      textOf(logged),
      'logged',
      'the call itself should still succeed',
    )
    assert.deepEqual(o.logs, ['log-info', 'log-warning', 'log-error'])
  },
)

/**
 * GW-026, second half, and the worse one: a request the *server* makes hangs.
 *
 * `sampling/createMessage` cannot work statelessly — the client would have to
 * POST its answer back, and with no session there is nothing to correlate that
 * answer with. That is a limitation. Hanging is not: the peer waits forever for
 * a reply that can never arrive, the tool call never returns, and the client
 * discovers this only by timing out. Every such call wedges a request and its
 * child.
 *
 * Failing fast — answering the child's request with a JSON-RPC error — costs
 * nothing and turns an indefinite hang into an error the caller can act on.
 * The timeout below is what makes the distinction testable.
 */
knownBugTest(
  'GW-026',
  `${stateless.label}: a server-initiated request fails fast instead of hanging`,
  { timeout: 90000 },
  async (t) => {
    const o = await connect(t, stateless)
    for (const tool of ['sample', 'roots', 'elicit']) {
      await assert.doesNotReject(
        () =>
          o.client.callTool({ name: tool, arguments: {} }, undefined, {
            timeout: 8000,
          }),
        `${tool} did not come back within 8s`,
      )
    }
  },
)
