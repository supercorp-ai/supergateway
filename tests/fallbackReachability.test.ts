import test from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  launchGateway,
  peerCommand,
  unusedPort,
} from './helpers/gateway-process.js'

/**
 * Who can actually reach the reverse bridges' fallback path, established by
 * driving it both ways rather than by reading the code.
 *
 * The bridge builds its upstream client from the *client's own* initialize
 * message. When the first stdio message is something else there is no
 * initialize to build from, so it falls back to a generic client — and that
 * branch is where GW-001 lived: it created the client and never forwarded the
 * request that caused it.
 *
 * The two tests below pin the two halves of the reachability claim:
 *   1. a conforming MCP client cannot reach the fallback, because the SDK
 *      sends `initialize` before anything else;
 *   2. a client that skips the handshake does reach it, and is now answered
 *      rather than dropped.
 *
 * Together they say why this crashed in the field for nobody: it needs a client
 * that violates the handshake.
 */

const FALLBACK_LOG = /creating fallback client/

test(
  'a conforming SDK client never reaches the fallback path',
  { timeout: 30000 },
  async (t) => {
    const port = await unusedPort()
    const upstream = launchGateway(t, [
      '--stdio',
      peerCommand,
      '--outputTransport',
      'sse',
      '--port',
      String(port),
    ])
    await upstream.ready()

    // The SDK owns the bridge process here, exactly as a real MCP host would.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['dist/index.js', '--sse', `http://127.0.0.1:${port}/sse`],
      stderr: 'pipe',
    })
    let diagnostics = ''
    const client = new Client(
      { name: 'conforming-probe', version: '1.0.0' },
      { capabilities: {} },
    )
    t.after(() => client.close().catch(() => {}))

    // Attached before connect, or the handshake's own diagnostics — the very
    // window the fallback would be logged in — would be missed and the
    // assertion below would pass on an empty string.
    transport.stderr?.on('data', (chunk: Buffer) => {
      diagnostics += chunk.toString('utf8')
    })
    await client.connect(transport)
    const tools = await client.listTools()
    await new Promise((resolve) => setTimeout(resolve, 200))

    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      ['add'],
      'the conforming client is served normally',
    )
    // Without this the doesNotMatch below could pass simply by capturing
    // nothing at all.
    assert.match(
      diagnostics,
      /Stdio → SSE|SSE → Stdio|Stdio server listening/,
      `the bridge's diagnostics were captured, got: ${JSON.stringify(diagnostics.slice(0, 200))}`,
    )
    assert.doesNotMatch(
      diagnostics,
      FALLBACK_LOG,
      'the SDK sends initialize first, so the bridge builds its client from ' +
        'that message and the fallback branch is never entered',
    )
  },
)

test(
  'a client that skips the handshake reaches the fallback and is answered',
  { timeout: 30000 },
  async (t) => {
    const port = await unusedPort()
    const upstream = launchGateway(t, [
      '--stdio',
      peerCommand,
      '--outputTransport',
      'sse',
      '--port',
      String(port),
    ])
    await upstream.ready()

    // Hand-rolled: raw JSON-RPC with no initialize, which no SDK client does.
    const bridge = launchGateway(t, ['--sse', `http://127.0.0.1:${port}/sse`])
    await bridge.ready()
    bridge.child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }) + '\n',
    )

    const reply = () =>
      bridge
        .output()
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line))
        .find((message) => message.id === 7)

    await bridge.waitFor(
      () => Boolean(reply()),
      'answer a first request that skipped the handshake',
    )

    assert.match(
      bridge.errors() + bridge.output(),
      FALLBACK_LOG,
      'this is the fallback branch, not the initialize one',
    )
    assert.deepEqual(
      reply().result.tools.map((tool: { name: string }) => tool.name),
      ['add'],
      'the request that triggered the fallback is answered, not discarded',
    )
    assert.equal(
      bridge.child.exitCode,
      null,
      'and the bridge is still running: this path used to dereference an ' +
        'unset result and die on the TypeError',
    )
  },
)
