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
 * Issue #156 / GW-022: a client states its protocol version in two places and
 * gets two different answers.
 *
 * In the `initialize` body it is a proposal — the SDK negotiates, and anything
 * it does not know comes back as the latest version it does know. In the
 * `mcp-protocol-version` header on every later request it is a demand: the SDK
 * matches it against a fixed list and answers 400 otherwise, with no
 * negotiation. So a client that is merely newer than the gateway connects
 * happily and then has every subsequent request rejected.
 *
 * The list below is deliberately read from the SDK at runtime rather than
 * written out here. The half of #156 that bites today is a *pin*: support for
 * 2025-11-25 landed in SDK 1.24.3, `package.json` already allows it, and only
 * the lockfile (and therefore the Docker image) holds us at 1.18.2. Deriving
 * the expectations means a lockfile bump moves that row from the known-bug test
 * to the passing one on its own, instead of leaving a stale constant behind.
 */
const FUTURE_VERSIONS = ['2025-11-25', '2026-07-28'].filter(
  (version) => !SUPPORTED_PROTOCOL_VERSIONS.includes(version),
)

const MODES = [
  { label: 'stateful', args: ['--stateful'] },
  { label: 'stateless', args: [] },
] as const

/**
 * A fresh gateway per case, not one for the whole loop.
 *
 * Both HTTP gateways leak a child per request until something closes the
 * transport (#108 stateless, #141 stateful — `childReaping.test.ts` owns both),
 * so a gateway held across a seven-version sweep trips the harness's
 * process-accumulation check and reports that defect from here instead of from
 * the test that names it. One gateway per case keeps this file about protocol
 * versions.
 */
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

/** The negotiated version, whether the SDK answers as JSON or as one SSE event. */
function negotiated(payload: string) {
  const line =
    payload
      .split('\n')
      .find((l) => l.startsWith('data:'))
      ?.slice(5) ?? payload
  return JSON.parse(line).result?.protocolVersion as string | undefined
}

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

  /**
   * The asymmetry itself. Every version here is one the body accepted a few
   * lines above — the gateway already told this client it was happy to talk to
   * it — and the header rejects it with `400 Bad Request: Unsupported protocol
   * version`. That is what the reporter is working around with a Cloudflare
   * rule that rewrites the header, since it is the only thing in the request
   * being checked this way.
   */
  knownBugTest(
    '#156',
    `${mode.label}: a header version the body negotiates is not rejected`,
    { timeout: 60000 },
    async (t) => {
      const refused: string[] = []
      for (const header of FUTURE_VERSIONS) {
        const url = await gateway(t, mode.args)
        const { session } = await initialize(url, '2025-06-18')
        const { status } = await afterInitialize(url, session, header)
        if (status !== 200) refused.push(`${header} -> ${status}`)
      }
      assert.deepEqual(refused, [])
    },
  )
}
