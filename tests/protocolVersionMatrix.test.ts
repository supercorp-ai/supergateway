import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import {
  launchGateway,
  unusedPort,
  peerCommand,
  gatewayTimeout,
  requestTimeout,
} from './helpers/gateway-process.js'

// Package tests may exercise a separately installed SDK version. Resolve the
// version list from that gateway, rather than from the test runner's checkout.
const gatewayRequire = createRequire(
  process.env.SUPERGATEWAY_TEST_ENTRY ?? import.meta.url,
)
const { SUPPORTED_PROTOCOL_VERSIONS } = await import(
  pathToFileURL(gatewayRequire.resolve('@modelcontextprotocol/sdk/types.js'))
    .href
)

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
    signal: AbortSignal.timeout(requestTimeout(10000)),
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
    { timeout: gatewayTimeout(60000) },
    async (t) => {
      for (const version of [
        ...SUPPORTED_PROTOCOL_VERSIONS,
        ...FUTURE_VERSIONS,
        '1900-01-01',
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
    { timeout: gatewayTimeout(60000) },
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
    { timeout: gatewayTimeout(60000) },
    async (t) => {
      for (const header of [
        ...FUTURE_VERSIONS.filter((version) => version !== '2026-07-28'),
        '1900-01-01',
      ]) {
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
    { timeout: gatewayTimeout(20000) },
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

test(
  'stateful: an unsupported header does not destroy the established session',
  { timeout: gatewayTimeout(20000) },
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
        'mcp-protocol-version': '1900-01-01',
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
    // SDK 1.30 reports this rejection through onerror; it must remain recoverable.
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

test(
  'stateful: a duplicate SSE GET preserves the session and its in-flight stream',
  { timeout: gatewayTimeout(20000) },
  async (t) => {
    const url = await gateway(t, ['--stateful'])
    const initial = await initialize(url, '2025-06-18')
    assert.ok(initial.session)
    const headers = {
      accept: 'text/event-stream',
      'mcp-session-id': initial.session,
      'mcp-protocol-version': negotiated(initial.body)!,
    }
    const controller = new AbortController()
    t.after(() => controller.abort())
    const first = await fetch(url, { headers, signal: controller.signal })
    assert.equal(first.status, 200)
    const duplicate = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(requestTimeout(5000)),
    })
    assert.equal(duplicate.status, 409)
    assert.match(await duplicate.text(), /Only one SSE stream/)
    const recovered = await afterInitialize(
      url,
      initial.session,
      negotiated(initial.body),
    )
    assert.equal(recovered.status, 200, recovered.body)
    assert.deepEqual(
      message(recovered.body).result.tools.map(
        (tool: { name: string }) => tool.name,
      ),
      ['add'],
    )
    assert.equal(controller.signal.aborted, false)
    controller.abort()
  },
)
