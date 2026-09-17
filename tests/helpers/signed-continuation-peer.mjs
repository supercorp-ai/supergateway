// An official-SDK stdio server whose multi-round `requestState` is signed with
// a key that lives only as long as this process, as the SDK's default does.
// Through the gateway, the client's next round must reach this same process.
import { randomBytes } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import {
  Server,
  inputRequired,
  createRequestStateCodec,
} from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'

const trace = (event) => {
  if (process.env.CONTINUATION_TRACE)
    appendFileSync(
      process.env.CONTINUATION_TRACE,
      JSON.stringify({ pid: process.pid, ...event }) + '\n',
    )
}
// Unsigned, constant state is a control: any process can resume it, so two
// backends mint identical tokens.
const constant = process.env.CONTINUATION_CONSTANT_STATE === '1'
const absent = process.env.CONTINUATION_NO_STATE === '1'
const codec = createRequestStateCodec({
  key:
    process.env.CONTINUATION_SHARED_TEST_KEY === '1'
      ? Buffer.alloc(32, 7)
      : randomBytes(32),
})
trace({ event: 'start' })
serveStdio(() => {
  const server = new Server(
    { name: 'signed-continuation', version: '1' },
    {
      capabilities: { tools: {} },
      ...(constant ? {} : { requestState: { verify: codec.verify } }),
    },
  )
  server.setRequestHandler('tools/list', async () => ({
    tools: [
      {
        name: 'roots',
        description: 'Round trip signed state through roots requests',
        inputSchema: {
          type: 'object',
          properties: { rounds: { type: 'number' } },
        },
      },
    ],
  }))
  server.setRequestHandler('tools/call', async (request, context) => {
    const rounds = request.params.arguments?.rounds ?? 1
    const previous = context.mcpReq.requestState()
    const round =
      absent && context.mcpReq.inputResponses?.locations
        ? 1
        : previous === undefined
          ? 0
          : constant
            ? Number(String(previous).split(':')[1])
            : previous.round
    if (!context.mcpReq.inputResponses?.locations) {
      trace({ event: 'mint', round: 1 })
      return inputRequired({
        inputRequests: { locations: inputRequired.listRoots() },
        ...(absent
          ? {}
          : {
              requestState: constant
                ? 'constant:1'
                : await codec.mint({
                    value: 'backend-owned signed state',
                    pid: process.pid,
                    round: 1,
                  }),
            }),
      })
    }
    trace({ event: 'resume', round, params: request.params })
    if (round < rounds) {
      trace({ event: 'mint', round: round + 1 })
      return inputRequired({
        inputRequests: { locations: inputRequired.listRoots() },
        requestState: constant
          ? `constant:${round + 1}`
          : await codec.mint({
              value: 'backend-owned signed state',
              pid: process.pid,
              round: round + 1,
            }),
      })
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            state: constant ? { value: previous } : previous,
            round,
            roots: context.mcpReq.inputResponses.locations,
          }),
        },
      ],
    }
  })
  return server
})
