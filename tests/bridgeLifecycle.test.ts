import { test } from 'node:test'
import assert from 'node:assert/strict'

// A bridge beside other entries is given the gateway's lifecycle: it must
// register with it rather than take the signals itself, and stop through it
// rather than exit the process, or the other entries' servers would be left
// running. The Streamable HTTP bridge's side is end to end, in
// stdioBesideHttpE2e.test.ts; the SSE bridge only stops after a 30s
// handshake deadline, so its side is here.
test('an SSE bridge given a lifecycle registers with it and stops through it', async (t) => {
  const remotes: { onclose?: () => void }[] = []
  t.mock.module('@modelcontextprotocol/sdk/client/index.js', {
    namedExports: { Client: class {} },
  })
  t.mock.module('@modelcontextprotocol/sdk/client/sse.js', {
    namedExports: {
      SSEClientTransport: class {
        onclose?: () => void
        constructor() {
          remotes.push(this)
        }
      },
    },
  })
  t.mock.module('@modelcontextprotocol/sdk/server/index.js', {
    namedExports: {
      Server: class {
        transport: unknown
        async connect(transport: unknown) {
          this.transport = transport
        }
      },
    },
  })
  t.mock.module('@modelcontextprotocol/sdk/server/stdio.js', {
    namedExports: { StdioServerTransport: class {} },
  })
  const signals: unknown[] = []
  t.mock.module(new URL('../src/lib/onSignals.js', import.meta.url).href, {
    namedExports: { onSignals: (options: unknown) => signals.push(options) },
  })
  const processExits: unknown[] = []
  t.mock.method(process, 'exit', (code: unknown) => {
    processExits.push(code)
  })
  const { sseToStdio } = await import('../src/gateways/sseToStdio.js')

  const registered: unknown[] = []
  const exits: number[] = []
  await sseToStdio({
    sseUrl: 'http://127.0.0.1:19003/sse',
    logger: { info() {}, error() {} },
    headers: {},
    lifecycle: {
      register: (cleanup) => registered.push(cleanup),
      exit: (code) => exits.push(code),
    },
  })
  // It has nothing of its own to clean up.
  assert.deepEqual(registered, [undefined])
  remotes[0].onclose!()
  assert.deepEqual(exits, [1])
  assert.deepEqual(signals, [], "the signals are the gateway's")
  assert.deepEqual(processExits, [], "the process is the gateway's")
})
