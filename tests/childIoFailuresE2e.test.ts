import { test } from 'node:test'
import { knownBugTest } from './helpers/known-bug.js'
import assert from 'node:assert/strict'
import { faultControl } from './helpers/fault-control.js'
import {
  initialize,
  launchGateway,
  rpc,
  unusedPort,
} from './helpers/gateway-process.js'

const peer = 'exec node tests/helpers/fault-peer.mjs'
const call = (name: string) => ({
  jsonrpc: '2.0',
  id: 7,
  method: 'tools/call',
  params: { name, arguments: {} },
})

for (const stateful of [true, false]) {
  for (const fault of [false, true]) {
    const check = fault ? knownBugTest.bind(null, '#177') : test
    check(
      `${stateful ? 'stateful' : 'stateless'} HTTP isolates ${fault ? 'a native spawn failure' : 'successful child spawns'}`,
      { timeout: 15000 },
      async (t) => {
        const port = await unusedPort()
        const gateway = launchGateway(
          t,
          [
            '--stdio',
            peer,
            '--outputTransport',
            'streamableHttp',
            '--port',
            String(port),
            ...(stateful ? ['--stateful'] : []),
          ],
          fault
            ? {
                NODE_OPTIONS: `--import=${new URL('./helpers/native-spawn-failure.mjs', import.meta.url).href}`,
              }
            : undefined,
        )
        await gateway.ready()
        const url = `http://127.0.0.1:${port}/mcp`
        const first = await rpc(url, initialize())
        assert.equal(first.response.status, 200)
        const session =
          first.response.headers.get('mcp-session-id') ?? undefined
        const second = await rpc(url, initialize(2)).catch(
          (error: Error) => error,
        )
        if (fault) {
          assert.match(gateway.errors(), /AUDIT: native spawn failure selected/)
          if (second instanceof Error)
            assert.notEqual(second.name, 'TimeoutError')
        } else {
          assert.ok(!(second instanceof Error))
          assert.equal(second.response.status, 200)
        }
        const healthy = await rpc(
          url,
          stateful ? call('identity') : initialize(3),
          session,
        ).catch((error: Error) => error)
        assert.ok(
          !(healthy instanceof Error),
          `healthy client lost the gateway: ${gateway.errors()}`,
        )
        assert.equal(healthy.response.status, 200)
        if (stateful)
          assert.equal(
            JSON.parse(healthy.messages[0].result.content[0].text).pid,
            Number(first.messages[0].result.serverInfo.version),
          )
      },
    )
  }
}

for (const stateful of [true, false]) {
  for (const fault of [false, true]) {
    const check = fault ? knownBugTest.bind(null, 'GW-032') : test
    check(
      `${stateful ? 'stateful' : 'stateless'} HTTP isolates ${fault ? 'a child closing stdin' : 'an ordinary child input stream'}`,
      { timeout: 15000 },
      async (t) => {
        const control = await faultControl(t)
        const port = await unusedPort()
        const gateway = launchGateway(
          t,
          [
            '--stdio',
            peer,
            '--outputTransport',
            'streamableHttp',
            '--port',
            String(port),
            ...(stateful ? ['--stateful'] : []),
          ],
          {
            FAULT_INIT: !stateful && fault ? '1' : '0',
            FAULT_CONTROL: control.url,
          },
        )
        await gateway.ready()
        const url = `http://127.0.0.1:${port}/mcp`
        const healthy = await rpc(url, initialize())
        const healthySession =
          healthy.response.headers.get('mcp-session-id') ?? undefined
        if (stateful) {
          const sick = await rpc(url, initialize(2))
          const session = sick.response.headers.get('mcp-session-id')!
          const prepared = await rpc(
            url,
            call(fault ? 'closeInput' : 'identity'),
            session,
          )
          assert.equal(prepared.response.status, 200)
          const pid = Number(sick.messages[0].result.serverInfo.version)
          assert.doesNotThrow(
            () => process.kill(pid, 0),
            'the peer is still alive after closing stdin',
          )
          const affected = await rpc(url, call('identity'), session).catch(
            (error: Error) => error,
          )
          if (affected instanceof Error)
            assert.notEqual(
              affected.name,
              'TimeoutError',
              'closed stdin must settle the affected request',
            )
        } else {
          const affected = await rpc(url, call('identity')).catch(
            (error: Error) => error,
          )
          if (affected instanceof Error)
            assert.notEqual(
              affected.name,
              'TimeoutError',
              'closed stdin must settle the affected request',
            )
        }
        if (fault) {
          await control.wait('stdin-closed')
        }
        const result = await rpc(
          url,
          stateful ? call('identity') : initialize(3),
          healthySession,
        ).catch((error: Error) => error)
        assert.ok(
          !(result instanceof Error),
          `healthy client lost the gateway: ${gateway.errors()}`,
        )
        assert.equal(result.response.status, 200)
        assert.equal(gateway.child.exitCode, null)
        assert.equal(gateway.child.signalCode, null)
      },
    )
  }
}
