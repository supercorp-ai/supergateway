import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialize } from './helpers/gateway-process.js'
import { enableFakeTimers } from './helpers/fake-timers.js'

test('Streamable HTTP reconnect retries with bounded backoff after SDK close', async (t) => {
  enableFakeTimers(t)
  let stdio: any
  let attempts = 0
  const remotes: any[] = []
  class Client {
    async connect() {
      attempts++
      if (attempts === 2 || attempts === 3) throw Error('upstream unavailable')
      await this.request(initialize(0))
    }
    async request(message: any) {
      return {
        protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
      }
    }
    async close() {}
  }
  class Remote {
    onclose?: () => void
    onerror?: (error: Error) => void
    constructor() {
      remotes.push(this)
    }
  }
  t.mock.module('@modelcontextprotocol/sdk/client/index.js', {
    namedExports: { Client },
  })
  t.mock.module('@modelcontextprotocol/sdk/client/streamableHttp.js', {
    namedExports: { StreamableHTTPClientTransport: Remote },
  })
  t.mock.module('@modelcontextprotocol/sdk/server/index.js', {
    namedExports: {
      Server: class {
        transport: any
        async connect(transport: any) {
          stdio = this.transport = transport
        }
      },
    },
  })
  t.mock.module('@modelcontextprotocol/sdk/server/stdio.js', {
    namedExports: { StdioServerTransport: class {} },
  })
  t.mock.module(new URL('../src/lib/onSignals.js', import.meta.url).href, {
    namedExports: { onSignals() {} },
  })
  t.mock.method(process.stdout, 'write', () => true)
  let closeDuringConnectedLog = true
  const logger = {
    info(message: string) {
      if (message === 'Streamable HTTP connected' && closeDuringConnectedLog) {
        closeDuringConnectedLog = false
        // Close between the connect promise's success and finally handlers.
        // Both can ask for a retry; only one timer should survive.
        remotes[0].onclose?.()
      }
    },
    error() {},
  }
  const { streamableHttpToStdio } = await import(
    '../src/gateways/streamableHttpToStdio.js'
  )
  await streamableHttpToStdio({
    streamableHttpUrl: 'http://127.0.0.1:19000/mcp',
    logger,
    headers: {},
  })
  await stdio.onmessage(initialize(1))
  assert.equal(attempts, 1)
  const flush = () => new Promise((resolve) => setImmediate(resolve))
  t.mock.timers.tick(999)
  assert.equal(attempts, 1)
  t.mock.timers.tick(1)
  await flush()
  assert.equal(attempts, 2)
  t.mock.timers.tick(1999)
  assert.equal(attempts, 2)
  t.mock.timers.tick(1)
  await flush()
  assert.equal(attempts, 3)
  t.mock.timers.tick(3999)
  assert.equal(attempts, 3)
  t.mock.timers.tick(1)
  await flush()
  assert.equal(attempts, 4)
  assert.equal(remotes.length, 4)
})
