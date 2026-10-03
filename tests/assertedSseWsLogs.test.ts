import { test } from 'node:test'
import assert from 'node:assert/strict'
// The `ws` client, not the global one: `WebSocket` is undefined on Node 20.
import { WebSocket } from 'ws'
import {
  gatewayTimeout,
  initialize,
  launchGateway,
  peerCommand,
  unusedPort,
} from './helpers/gateway-process.js'

// What the operator of a stdio→WS gateway reads about one client's
// connection, end to end against the built CLI: the line naming the new
// client, each message relayed in either direction under that client's id,
// and the line saying it left. An operator follows a client through the log
// by its id, so every line has to carry the same one.

const prefix = '[supergateway] '
const lines = (output: string) =>
  output
    .split('\n')
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length))

test(
  'stdio→WS logs a client’s connection, its messages both ways and its leaving under one id',
  { timeout: gatewayTimeout(30000) },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      peerCommand,
      '--outputTransport',
      'ws',
      '--port',
      String(port),
    ])
    await gateway.ready()

    const socket = new WebSocket(`ws://127.0.0.1:${port}/message`)
    t.after(() => socket.terminate())
    const frames: string[] = []
    socket.on('message', (data: Buffer) => frames.push(data.toString('utf8')))
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })

    const connected = () =>
      lines(gateway.output())
        .map((line) => /^New WebSocket connection: (\S+)$/.exec(line)?.[1])
        .find(Boolean)
    await gateway.waitFor(() => Boolean(connected()), 'log the new client')
    const clientId = connected()!

    const request = initialize(1)
    socket.send(JSON.stringify(request))
    await gateway.waitFor(() => frames.length === 1, 'answer initialize')
    // map: the request, as the client sent it, under the client's id
    // map: the reply, as the child wrote it, under the same id
    await gateway.waitFor(
      () =>
        lines(gateway.output()).includes(
          `Child → WebSocket (client ${clientId}): ${frames[0]}`,
        ),
      'log the reply',
    )
    assert.equal(JSON.parse(frames[0]).id, 1)
    assert.ok(
      lines(gateway.output()).includes(
        `WebSocket → Child (client ${clientId}): ${JSON.stringify(request)}`,
      ),
      gateway.output(),
    )

    // map: the client leaving, under the same id
    socket.close()
    await gateway.waitFor(
      () =>
        lines(gateway.output()).includes(
          `WebSocket connection closed: ${clientId}`,
        ),
      'log the client leaving',
    )

    // map: the order the operator reads them in, up to the client leaving
    // (its child's exit can follow it)
    const about = lines(gateway.output()).filter((line) =>
      line.includes(clientId),
    )
    const left = about.indexOf(`WebSocket connection closed: ${clientId}`)
    assert.deepEqual(
      about.slice(0, left + 1).map((line) => line.replace(/: .*$/, '')),
      [
        'New WebSocket connection',
        'WebSocket → Child (client ' + clientId + ')',
        'Child → WebSocket (client ' + clientId + ')',
        'WebSocket connection closed',
      ],
    )
  },
)
