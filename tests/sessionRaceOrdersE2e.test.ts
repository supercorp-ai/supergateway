import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  initialize,
  launchGateway,
  rpc,
  unusedPort,
} from './helpers/gateway-process.js'
import { pendingRpc, within } from './helpers/lifecycle-control.js'
import { faultControl } from './helpers/fault-control.js'

const call = (id: number, name: string) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: {} },
})
for (const order of [
  'reply-then-delete',
  'delete-then-reply',
  'exit-then-delete',
  'delete-then-exit',
] as const) {
  test(
    `stateful ${order} settles affected work while another session retains its peer`,
    { timeout: 15000 },
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
          '--stateful',
          '--port',
          String(port),
          '--sessionTimeout',
          '5000',
        ],
        {
          FAULT_CONTROL: control.url,
          FAULT_LATE_TERM: order.startsWith('delete-') ? '1' : '0',
        },
      )
      await gateway.ready()
      const url = `http://127.0.0.1:${port}/mcp`
      const a = await rpc(url, initialize()),
        b = await rpc(url, initialize())
      const aSession = a.response.headers.get('mcp-session-id')!,
        bSession = b.response.headers.get('mcp-session-id')!
      const aPid = Number(a.messages[0].result.serverInfo.version),
        bPid = Number(b.messages[0].result.serverInfo.version)
      const pending = pendingRpc(t, url, call(7, 'hold'), aSession)
      const barrier = await control.wait('hold', aPid)
      const deleteA = async () => {
        const response = await fetch(url, {
          method: 'DELETE',
          headers: { 'mcp-session-id': aSession },
          signal: AbortSignal.timeout(2000),
        })
        await response.text()
        return response.status
      }
      if (order === 'reply-then-delete') {
        barrier.response.end('release')
        const reply = await pending.settled
        assert.equal(reply.kind, 'response')
        if (reply.kind === 'response') assert.match(reply.text, /"id":7/)
        assert.equal(await deleteA(), 200)
      } else if (order === 'exit-then-delete') {
        barrier.response.end('exit')
        await gateway.waitFor(
          () => gateway.errors().includes('Child exited: code=17'),
          'observe peer exit before DELETE',
        )
        assert.ok((await deleteA()) >= 400)
      } else {
        assert.equal(await deleteA(), 200)
        // A faulting peer ignores SIGTERM while held, allowing us to witness a
        // real late write/exit after DELETE, rather than releasing a dead peer.
        barrier.response.end(order === 'delete-then-exit' ? 'exit' : 'release')
        if (order === 'delete-then-reply')
          await control.wait('held-reply', aPid)
        else
          await gateway.waitFor(
            () => gateway.errors().includes('Child exited: code=17'),
            'observe peer exit after DELETE',
          )
      }
      const ended = await within(
        pending.settled,
        'settle work after session termination',
        2500,
      )
      if (ended.kind === 'error')
        assert.notEqual(ended.error.name, 'TimeoutError')
      const survivor = await rpc(url, call(7, 'identity'), bSession)
      assert.equal(survivor.response.status, 200)
      assert.equal(survivor.messages.length, 1)
      assert.equal(
        JSON.parse(survivor.messages[0].result.content[0].text).pid,
        bPid,
      )
      const old = await rpc(url, call(8, 'identity'), aSession)
      assert.ok(old.response.status >= 400 && old.response.status < 500)
      assert.equal(gateway.child.exitCode, null)
      assert.doesNotMatch(
        gateway.errors(),
        /UnhandledPromiseRejection|EPIPE|Maximum call stack/,
      )
    },
  )
}
