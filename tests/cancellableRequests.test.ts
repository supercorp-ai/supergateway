import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { CancellableRequests } from '../src/lib/cancellableRequests.js'

const cancel = (params?: Record<string, unknown>): JSONRPCMessage => ({
  jsonrpc: '2.0',
  method: 'notifications/cancelled',
  ...(params ? { params } : {}),
})

test('a cancel aborts the request the client named, with its reason', () => {
  const requests = new CancellableRequests({ info() {}, error() {} })
  const named = requests.begin('call-A')
  const other = requests.begin(1)
  assert.equal(
    requests.cancel(cancel({ requestId: 'call-A', reason: 'stop' })),
    true,
  )
  assert.equal(named.aborted, true)
  assert.equal(named.reason, 'stop')
  assert.equal(other.aborted, false, 'only the named request')

  requests.cancel(cancel({ requestId: 1 }))
  assert.equal(other.reason, 'Cancelled by the client', 'a default reason')
})

test('a cancel for no pending request is swallowed, not relayed', () => {
  const logged: unknown[] = []
  const requests = new CancellableRequests({
    info: (...args: unknown[]) => logged.push(args[0]),
    error() {},
  })
  const done = requests.begin('1')
  requests.end('1')
  for (const message of [
    cancel({ requestId: '1' }),
    cancel({ requestId: 1 }),
    cancel(),
  ])
    assert.equal(requests.cancel(message), true)
  assert.equal(done.aborted, false, 'a finished request stays finished')
  assert.equal(logged.length, 3)
})

test('everything else is left to relay', () => {
  const requests = new CancellableRequests({ info() {}, error() {} })
  assert.equal(
    requests.cancel({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    false,
  )
  assert.equal(requests.cancel({ jsonrpc: '2.0', id: 3, result: {} }), false)
})
