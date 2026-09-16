import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { faultControl } from './helpers/fault-control.js'
import {
  initialize,
  rpc,
  launchGateway,
  unusedPort,
} from './helpers/gateway-process.js'

function sdk(t: TestContext, url: string) {
  const client = new Client({ name: 'exit-test', version: '1' })
  const transport = new StreamableHTTPClientTransport(new URL(url))
  t.after(() => client.close())
  t.after(() => transport.close())
  return { client, transport }
}
const processFailure = (error: any) => {
  assert.equal(
    error.code,
    -32603,
    'child exit must settle the SDK call before its timeout',
  )
  assert.match(error.message, /MCP server process failed/)
  assert.equal(error.data, undefined, 'process diagnostics stay in server logs')
  return true
}
const call = (client: Client, name: string) =>
  client.callTool({ name, arguments: {} }, undefined, { timeout: 4000 })

for (const stateful of [false, true]) {
  const mode = stateful ? 'stateful' : 'stateless'
  for (const exit of [
    'process.exit(0)',
    'process.exit(17)',
    'process.kill(process.pid, "SIGTERM")',
  ]) {
    test(
      `${mode} SDK initialize receives a protocol error after ${exit} (#139)`,
      { timeout: 15000 },
      async (t) => {
        const port = await unusedPort()
        const gateway = launchGateway(t, [
          '--stdio',
          `exec node -e '${exit}'`,
          '--outputTransport',
          'streamableHttp',
          '--port',
          String(port),
          '--healthEndpoint',
          '/health',
          ...(stateful ? ['--stateful'] : []),
        ])
        await gateway.ready()
        const { client, transport } = sdk(t, `http://127.0.0.1:${port}/mcp`)
        await assert.rejects(
          client.connect(transport, { timeout: 4000 }),
          processFailure,
        )
        assert.equal(gateway.child.exitCode, null)
        const health = await fetch(`http://127.0.0.1:${port}/health`)
        assert.equal(health.status, 200)
        await health.text()
      },
    )
  }

  test(
    `${mode} SDK child exit settles pending calls and preserves another active client`,
    { timeout: 20000 },
    async (t) => {
      const control = await faultControl(t)
      const port = await unusedPort()
      const gateway = launchGateway(
        t,
        [
          '--stdio',
          'exec node tests/helpers/fault-peer.mjs',
          '--outputTransport',
          'streamableHttp',
          '--port',
          String(port),
          ...(stateful ? ['--stateful'] : []),
        ],
        { FAULT_CONTROL: control.url },
      )
      await gateway.ready()
      const url = `http://127.0.0.1:${port}/mcp`
      const broken = sdk(t, url)
      const healthy = sdk(t, url)
      await broken.client.connect(broken.transport)
      await healthy.client.connect(healthy.transport)
      const failed = assert.rejects(call(broken.client, 'hold'), processFailure)
      failed.catch(() => {})
      const held = await control.wait('hold')
      const extra = stateful
        ? assert.rejects(call(broken.client, 'hold'), processFailure)
        : Promise.resolve()
      extra.catch(() => {})
      if (stateful)
        await gateway.waitFor(
          () =>
            control.events.filter(
              (e) => e.kind === 'hold' && e.pid === held.pid,
            ).length === 2,
          'observe two pending calls on the failing session',
        )
      let healthySettled = false
      const otherCall = call(healthy.client, 'hold').finally(() => {
        healthySettled = true
      })
      otherCall.catch(() => {})
      await gateway.waitFor(
        () =>
          control.events.some((e) => e.kind === 'hold' && e.pid !== held.pid),
        'observe the independent active child',
      )
      const other = control.events.find(
        (e) => e.kind === 'hold' && e.pid !== held.pid,
      )!
      held.response.end('exit')
      await Promise.all([failed, extra])
      assert.equal(
        healthySettled,
        false,
        'a child crash must not settle another client’s active call',
      )
      other.response.end('release')
      const result = await otherCall
      assert.equal(JSON.parse((result.content as any[])[0].text).pid, other.pid)
      const fresh = sdk(t, url)
      await fresh.client.connect(fresh.transport)
      assert.equal((await call(fresh.client, 'identity')).isError, undefined)
      assert.equal(gateway.child.exitCode, null)
    },
  )
}

test(
  'stateless SDK receives the original call error when automatic initialization crashes',
  { timeout: 15000 },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      'exec node tests/helpers/exit-init-peer.mjs',
      '--outputTransport',
      'streamableHttp',
      '--port',
      String(port),
    ])
    await gateway.ready()
    const { client, transport } = sdk(t, `http://127.0.0.1:${port}/mcp`)
    await client.connect(transport)
    await assert.rejects(call(client, 'identity'), processFailure)
    assert.equal(gateway.child.exitCode, null)
  },
)

for (const stateful of [false, true]) {
  test(
    `${stateful ? 'stateful' : 'stateless'} preserves a complete reply immediately before child exit`,
    { timeout: 15000 },
    async (t) => {
      const port = await unusedPort()
      const gateway = launchGateway(t, [
        '--stdio',
        'exec node tests/helpers/exit-init-peer.mjs reply-exit',
        '--outputTransport',
        'streamableHttp',
        '--port',
        String(port),
        ...(stateful ? ['--stateful'] : []),
      ])
      await gateway.ready()
      const response = await rpc(
        `http://127.0.0.1:${port}/mcp`,
        initialize('finished'),
      )
      assert.equal(
        response.messages.length,
        1,
        'do not replace or duplicate an already completed reply',
      )
      assert.equal(response.messages[0].id, 'finished')
      assert.equal(
        response.messages[0].result.serverInfo.name,
        'exit-init-peer',
      )
      await gateway.waitFor(
        () => gateway.errors().includes('Child exited:'),
        'observe exit after the completed reply',
      )
      assert.doesNotMatch(
        gateway.errors(),
        /Child process failure:/,
        'a completed reply must not be logged as a process failure',
      )
    },
  )
}
