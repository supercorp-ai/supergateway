import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  gatewayTimeout,
  launchGateway,
  unusedPort,
} from './helpers/gateway-process.js'

// Remote servers (`url` entries) served over HTTP, end to end against the
// built CLI: what the operator is told when the remote server fails a session.

const options = { timeout: gatewayTimeout(30000) }

const serve = async (t: TestContext, config: Record<string, unknown>) => {
  const port = await unusedPort()
  const dir = mkdtempSync(join(tmpdir(), 'sg-asserted-remote-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'servers.json')
  writeFileSync(file, JSON.stringify({ port, ...config }, null, 2))
  const gateway = launchGateway(t, ['--config', file, '--logFormat', 'json'])
  await gateway.ready()
  return { base: `http://127.0.0.1:${port}`, gateway }
}

// The gateway's error log, one JSON object per line on stderr.
const errorLog = (gateway: ReturnType<typeof launchGateway>) =>
  gateway
    .errors()
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map(
      (line) =>
        JSON.parse(line) as {
          level: string
          msg: string
          server?: string
          data?: any
        },
    )

test(
  'a remote server that is not there is logged as an upstream error of the session it failed',
  options,
  async (t) => {
    const gone = `http://127.0.0.1:${await unusedPort()}`
    const { base, gateway } = await serve(t, {
      mcpServers: {
        downHttp: {
          url: `${gone}/mcp`,
          type: 'http',
          outputTransport: 'streamableHttp',
          stateful: true,
        },
        downSse: {
          url: `${gone}/sse`,
          type: 'sse',
          outputTransport: 'streamableHttp',
          stateful: true,
        },
      },
    })
    for (const name of ['downHttp', 'downSse']) {
      const client = new Client({ name: 'test', version: '1.0.0' })
      t.after(() => client.close())
      await assert.rejects(
        client.connect(
          new StreamableHTTPClientTransport(new URL(`${base}/${name}/mcp`)),
        ),
      )
    }
    const logged = (msg: string) =>
      errorLog(gateway).filter((entry) => entry.msg === msg)
    // The transport reports its error before the send it failed rejects, and
    // that rejection fails the session.
    await gateway.waitFor(
      () => logged('Child process failure:').length === 2,
      'fail both sessions',
    )
    // map: the remote server's failure is logged against its own entry and
    // session, with the error each transport reported
    const upstreamErrors = logged('Session: upstream error:')
    assert.deepEqual(
      upstreamErrors.map(({ level, server, data }) => ({
        level,
        server,
        name: data.name,
      })),
      [
        { level: 'error', server: 'downHttp', name: 'TypeError' },
        { level: 'error', server: 'downSse', name: 'Error' },
      ],
    )
    const [http, sse] = upstreamErrors
    assert.equal(http.data.message, 'fetch failed')
    assert.match(sse.data.message, /^SSE error: TypeError: fetch failed/)
  },
)
