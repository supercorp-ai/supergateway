import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  launchGateway,
  unusedPort,
  peerCommand,
} from './helpers/gateway-process.js'

/**
 * Point the gateway at itself.
 *
 * Every other test puts one gateway between a client and a server, so a
 * behaviour that is wrong in a *consistent* way — an id rewritten the same way
 * on both legs, a field dropped on the way out and re-derived on the way back —
 * looks correct from the outside. Composition removes that cover: the same code
 * has to be both halves at once, and any asymmetry between what it accepts and
 * what it emits shows up as a difference from the direct answer.
 *
 * It is also a configuration users actually build. A stdio server exposed over
 * HTTP for a remote host, re-attached locally as stdio for an editor that only
 * speaks stdio, is two supergateways in a row.
 *
 * The chain below is every bridge in the codebase except WebSocket, in one
 * pipeline:
 *
 *   peer ──stdio──▶ G1 (stdio→streamableHttp) ──http──▶
 *   G2 (streamableHttp→stdio) ──stdio──▶ G3 (stdio→SSE) ──sse──▶ client
 *
 * G2 is spawned *by* G3 as its `--stdio` command, which is exactly how a user
 * would wire it.
 */
const TOOL = 'add'
const ARGS = { a: 2, b: 3 }
const EXPECTED = 'The sum of 2 and 3 is 5.'

type Reply = { content: Array<{ type: string; text: string }> }

test(
  'a gateway in front of a gateway answers exactly as one gateway does',
  { timeout: 60000 },
  async (t) => {
    const directPort = await unusedPort()
    const direct = launchGateway(t, [
      '--stdio',
      peerCommand,
      '--port',
      String(directPort),
      '--outputTransport',
      'streamableHttp',
      '--stateful',
    ])
    await direct.ready()

    const chainPort = await unusedPort()
    const chain = launchGateway(t, [
      '--stdio',
      // G2: re-attaches the HTTP endpoint above as a stdio server.
      `node dist/index.js --streamableHttp http://127.0.0.1:${directPort}/mcp --outputTransport stdio --logLevel none`,
      '--port',
      String(chainPort),
      '--outputTransport',
      'sse',
    ])
    await chain.ready()

    const open = async (
      transport: SSEClientTransport | StreamableHTTPClientTransport,
    ) => {
      const client = new Client({ name: 'composition', version: '1.0.0' })
      t.after(() => client.close().catch(() => {}))
      await client.connect(transport)
      return client
    }

    const one = await open(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${directPort}/mcp`),
      ),
    )
    const two = await open(
      new SSEClientTransport(new URL(`http://127.0.0.1:${chainPort}/sse`)),
    )

    const [toolsOne, toolsTwo] = await Promise.all([
      one.listTools(),
      two.listTools(),
    ])
    assert.deepEqual(
      toolsTwo.tools.map((tool) => tool.name).sort(),
      toolsOne.tools.map((tool) => tool.name).sort(),
      'the composed chain advertises a different tool set',
    )
    // Not just the names: a schema mangled on one leg and unmangled on the
    // other would still pass the comparison above.
    assert.deepEqual(
      toolsTwo.tools.map((tool) => tool.inputSchema),
      toolsOne.tools.map((tool) => tool.inputSchema),
      'the composed chain rewrote a tool schema',
    )

    const [replyOne, replyTwo] = (await Promise.all([
      one.callTool({ name: TOOL, arguments: ARGS }),
      two.callTool({ name: TOOL, arguments: ARGS }),
    ])) as [Reply, Reply]
    assert.equal(replyOne.content[0].text, EXPECTED)
    assert.deepEqual(
      replyTwo.content,
      replyOne.content,
      'the composed chain changed the result',
    )
  },
)

/**
 * Three clients, one chain. The SSE gateway at the end of it is the same code
 * GW-017 is about, so this also says whether composition makes that worse: the
 * assertion here is only that every client that *does* connect gets its own
 * reply, not another client's.
 */
test(
  'a composed chain keeps concurrent callers apart',
  { timeout: 60000 },
  async (t) => {
    const innerPort = await unusedPort()
    const inner = launchGateway(t, [
      '--stdio',
      peerCommand,
      '--port',
      String(innerPort),
      '--outputTransport',
      'streamableHttp',
      '--stateful',
    ])
    await inner.ready()

    const outerPort = await unusedPort()
    const outer = launchGateway(t, [
      '--stdio',
      `node dist/index.js --streamableHttp http://127.0.0.1:${innerPort}/mcp --outputTransport stdio --logLevel none`,
      '--port',
      String(outerPort),
      '--outputTransport',
      'streamableHttp',
      '--stateful',
    ])
    await outer.ready()

    const url = new URL(`http://127.0.0.1:${outerPort}/mcp`)
    const callers = await Promise.all(
      [1, 2, 3].map(async (n) => {
        const client = new Client({ name: `caller-${n}`, version: '1.0.0' })
        t.after(() => client.close().catch(() => {}))
        await client.connect(new StreamableHTTPClientTransport(url))
        return { n, client }
      }),
    )

    const replies = await Promise.all(
      callers.map(async ({ n, client }) => {
        const reply = (await client.callTool({
          name: TOOL,
          arguments: { a: n, b: n },
        })) as Reply
        return reply.content[0].text
      }),
    )
    assert.deepEqual(replies, [
      'The sum of 1 and 1 is 2.',
      'The sum of 2 and 2 is 4.',
      'The sum of 3 and 3 is 6.',
    ])
  },
)
