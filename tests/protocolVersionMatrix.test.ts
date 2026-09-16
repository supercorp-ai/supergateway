import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js'
import { knownBugTest } from './helpers/known-bug.js'
import {
  launchGateway,
  unusedPort,
  peerCommand,
} from './helpers/gateway-process.js'

/**
 * Legacy initialization proposes a version; subsequent requests must use the
 * negotiated version. An unsupported header must be rejected (HTTP 400).
 * Modern 2026 discovery/requests are tested with a real client separately in
 * modernProtocol.test.ts. These initialization tests do not establish modern
 * compatibility.
 */
const FUTURE_VERSIONS = ['2025-11-25', '2026-07-28'].filter(
  (version) => !SUPPORTED_PROTOCOL_VERSIONS.includes(version),
)

const MODES = [
  { label: 'stateful', args: ['--stateful'] },
  { label: 'stateless', args: [] },
] as const

async function gateway(t: TestContext, extra: readonly string[]) {
  const port = await unusedPort()
  const process_ = launchGateway(t, [
    '--stdio',
    peerCommand,
    '--port',
    String(port),
    '--outputTransport',
    'streamableHttp',
    ...extra,
  ])
  await process_.ready()
  return `http://127.0.0.1:${port}/mcp`
}

const post = (url: string, body: unknown, extra: Record<string, string> = {}) =>
  fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...extra,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })

/** Parse a JSON response or a single SSE result. */
function message(payload: string) {
  const line =
    payload
      .split('\n')
      .find((l) => l.startsWith('data:'))
      ?.slice(5) ?? payload
  return JSON.parse(line)
}

const negotiated = (payload: string) =>
  message(payload).result?.protocolVersion as string | undefined

async function initialize(url: string, version: string) {
  const response = await post(url, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: version,
      capabilities: {},
      clientInfo: { name: 'matrix', version: '1.0.0' },
    },
  })
  const session = response.headers.get('mcp-session-id') ?? undefined
  return { response, session, body: await response.text() }
}

/** A `tools/list` sent the way a client sends everything after initialize. */
async function afterInitialize(
  url: string,
  session: string | undefined,
  header: string | undefined,
) {
  const extra: Record<string, string> = {}
  if (session) extra['mcp-session-id'] = session
  if (header) extra['mcp-protocol-version'] = header
  if (session)
    await post(
      url,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      extra,
    )
  const response = await post(
    url,
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    extra,
  )
  return { status: response.status, body: await response.text() }
}

for (const mode of MODES) {
  test(
    `${mode.label}: every protocol version in the initialize body negotiates`,
    { timeout: 60000 },
    async (t) => {
      for (const version of [
        ...SUPPORTED_PROTOCOL_VERSIONS,
        ...FUTURE_VERSIONS,
        'not-a-version',
      ]) {
        const url = await gateway(t, mode.args)
        const { response, body } = await initialize(url, version)
        assert.equal(
          response.status,
          200,
          `initialize with ${version} was refused: ${body.slice(0, 200)}`,
        )
        const agreed = negotiated(body)
        assert.ok(
          agreed && SUPPORTED_PROTOCOL_VERSIONS.includes(agreed),
          `initialize with ${version} agreed on ${agreed}`,
        )
      }
    },
  )

  test(
    `${mode.label}: a supported protocol version in the header is accepted`,
    { timeout: 60000 },
    async (t) => {
      for (const header of [undefined, ...SUPPORTED_PROTOCOL_VERSIONS]) {
        const url = await gateway(t, mode.args)
        const { session } = await initialize(url, '2025-06-18')
        const { status, body } = await afterInitialize(url, session, header)
        assert.equal(
          status,
          200,
          `header ${header ?? '(none)'} gave ${status}: ${body.slice(0, 200)}`,
        )
      }
    },
  )

  test(
    `${mode.label}: unsupported protocol headers are rejected`,
    { timeout: 60000 },
    async (t) => {
      for (const header of [...FUTURE_VERSIONS, 'not-a-version']) {
        const url = await gateway(t, mode.args)
        const { session } = await initialize(url, '2025-06-18')
        const response = await post(
          url,
          { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
          {
            ...(session ? { 'mcp-session-id': session } : {}),
            'mcp-protocol-version': header,
          },
        )
        assert.equal(response.status, 400)
        const error = await response.json()
        assert.equal(error.jsonrpc, '2.0')
        assert.equal(error.error.code, -32000)
        assert.match(error.error.message, /Unsupported protocol version/)
      }
    },
  )

  test(
    `${mode.label}: a future proposal remains usable with the negotiated legacy version`,
    { timeout: 20000 },
    async (t) => {
      const url = await gateway(t, mode.args)
      const { response, session, body } = await initialize(url, '2026-07-28')
      assert.equal(response.status, 200)
      const version = negotiated(body)
      assert.ok(version && SUPPORTED_PROTOCOL_VERSIONS.includes(version))
      const reply = await afterInitialize(url, session, version)
      assert.equal(reply.status, 200)
      assert.deepEqual(
        message(reply.body).result.tools.map(
          (tool: { name: string }) => tool.name,
        ),
        ['add'],
      )
    },
  )
}

knownBugTest(
  '#156',
  'stateful: an unsupported header does not destroy the established session',
  { timeout: 20000 },
  async (t) => {
    const url = await gateway(t, ['--stateful'])
    const affected = await initialize(url, '2025-06-18')
    const healthy = await initialize(url, '2025-06-18')
    assert.equal(affected.response.status, 200)
    assert.equal(healthy.response.status, 200)
    assert.ok(affected.session)
    assert.ok(healthy.session)
    assert.notEqual(affected.session, healthy.session)
    const headers = { 'mcp-session-id': affected.session }
    const rejected = await post(
      url,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      {
        ...headers,
        'mcp-protocol-version': '2026-07-28',
      },
    )
    assert.equal(rejected.status, 400)
    assert.match(
      (await rejected.json()).error.message,
      /Unsupported protocol version/,
    )
    // Confirm the gateway and an independent child remain healthy first.
    const other = await afterInitialize(
      url,
      healthy.session,
      negotiated(healthy.body),
    )
    assert.equal(other.status, 200)
    assert.deepEqual(
      message(other.body).result.tools.map(
        (tool: { name: string }) => tool.name,
      ),
      ['add'],
    )
    // The rejected request was not a DELETE, timeout, or child failure.
    // SDK 1.30 emits onerror for it; the gateway currently kills this session.
    const recovered = await afterInitialize(
      url,
      affected.session,
      negotiated(affected.body),
    )
    assert.equal(recovered.status, 200, recovered.body)
    assert.deepEqual(
      message(recovered.body).result.tools.map(
        (tool: { name: string }) => tool.name,
      ),
      ['add'],
    )
  },
)
