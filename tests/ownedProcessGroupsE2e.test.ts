import { test } from 'node:test'
import assert from 'node:assert/strict'
import { processInfo, stopped, reapAfter } from './helpers/process-tree.js'
import { auditClient } from './helpers/audit-client.js'
import {
  initialize,
  launchGateway,
  rpc,
  unusedPort,
} from './helpers/gateway-process.js'

for (const mode of ['sse', 'stateful', 'stateless', 'ws'] as const) {
  for (const trigger of [
    'wrapper-exit',
    'repeated-signals',
    'stdin-close',
  ] as const) {
    test(
      `${mode} cleans a TERM-resistant descendant after ${trigger}`,
      { timeout: 15000, skip: process.platform === 'win32' },
      async (t) => {
        const b = await auditClient(
          t,
          mode,
          'exec node tests/helpers/fault-wrapper.mjs',
          { FAULT_IGNORE_TERM: '1' },
        )
        const peer = processInfo(b.pid)
        assert.equal(peer.alive, true)
        assert.notEqual(
          peer.parent,
          b.gateway.child.pid,
          'the MCP peer is a descendant behind the wrapper',
        )
        reapAfter(t, b.pid, peer.group)
        if (trigger === 'wrapper-exit') {
          // The wrapper dies first. SIGTERM on its surviving group is ignored by
          // the peer, so neither wrapper exit nor transport closure proves cleanup.
          process.kill(peer.parent, 'SIGTERM')
          await stopped(b.pid)
          if (mode === 'sse' || mode === 'ws')
            assert.equal((await b.gateway.exited).code, 1)
          else
            assert.equal(
              b.gateway.child.exitCode,
              null,
              'HTTP gateway remains available',
            )
        } else {
          if (trigger === 'stdin-close') b.gateway.child.stdin.end()
          else {
            b.gateway.child.kill('SIGTERM')
            await b.gateway.waitFor(
              () => b.gateway.output().includes('Caught SIGTERM'),
              'start graceful shutdown',
            )
            b.gateway.child.kill('SIGINT')
            b.gateway.child.kill('SIGHUP')
          }
          assert.equal((await b.gateway.exited).code, 0)
          await stopped(b.pid)
        }
      },
    )
  }
}

for (const termination of ['DELETE', 'idle-expiry']) {
  test(
    `stateful ${termination} stops only its owned group and preserves a second session`,
    { timeout: 15000, skip: process.platform === 'win32' },
    async (t) => {
      const port = await unusedPort()
      const gateway = launchGateway(
        t,
        [
          '--stdio',
          'exec node tests/helpers/fault-wrapper.mjs',
          '--stateful',
          '--outputTransport',
          'streamableHttp',
          '--port',
          String(port),
          '--sessionTimeout',
          '500',
        ],
        { FAULT_IGNORE_TERM: '1' },
      )
      await gateway.ready()
      const url = `http://127.0.0.1:${port}/mcp`
      const open = async (id: number) => {
        const result = await rpc(url, initialize(id))
        const pid = Number(result.messages[0].result.serverInfo.version)
        const group = processInfo(pid).group
        reapAfter(t, pid, group)
        return {
          pid,
          group,
          session: result.response.headers.get('mcp-session-id')!,
        }
      }
      const affected = await open(1),
        healthy = await open(2)
      assert.notEqual(
        affected.group,
        healthy.group,
        'sessions own separate groups',
      )
      // A live GET keeps only the healthy session active throughout escalation.
      const abort = new AbortController()
      t.after(() => abort.abort())
      const stream = await fetch(url, {
        headers: {
          'mcp-session-id': healthy.session,
          accept: 'text/event-stream',
        },
        signal: abort.signal,
      })
      assert.equal(stream.status, 200)
      const ended = stream.text().catch(() => '')
      t.after(() => ended)
      if (termination === 'DELETE') {
        const response = await fetch(url, {
          method: 'DELETE',
          headers: { 'mcp-session-id': affected.session },
        })
        assert.equal(response.status, 200)
        await response.text()
      }
      await stopped(affected.pid)
      assert.equal(processInfo(healthy.pid).alive, true)
      const identity = await rpc(
        url,
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'identity' },
        },
        healthy.session,
      )
      assert.equal(
        JSON.parse(identity.messages[0].result.content[0].text).pid,
        healthy.pid,
      )
      assert.equal(
        (await rpc(url, initialize(4), affected.session)).response.status,
        400,
      )
      abort.abort()
    },
  )
}
