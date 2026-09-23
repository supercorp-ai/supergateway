import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  launchGateway,
  peerCommand,
  unusedPort,
} from './helpers/gateway-process.js'

/**
 * Read an SSE stream into an array of `data:` payloads as they arrive.
 *
 * The SDK client is deliberately not used here: it pairs each reply with the
 * request that asked for it, which is exactly the property under test, so a
 * reply delivered to the wrong client would be discarded before any assertion
 * could see it. Reading the wire directly is the only way to observe what each
 * session was actually sent.
 */
function readFrames(response: Response) {
  const frames: string[] = []
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines)
        if (line.startsWith('data:')) frames.push(line.slice(5).trim())
    }
  })().catch(() => {})
  return frames
}

/**
 * Each SSE session owns its own child. Replies must stay on the session that
 * made the request even when another session is connected at the same time.
 */
test(
  'one SSE client does not receive another client’s replies',
  { timeout: 30000 },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      peerCommand,
      '--port',
      String(port),
    ])
    await gateway.ready()

    const connect = async () => {
      const response = await fetch(`http://127.0.0.1:${port}/sse`, {
        headers: { accept: 'text/event-stream' },
      })
      assert.equal(response.status, 200)
      const frames = readFrames(response)
      await gateway.waitFor(
        () => frames.some((frame) => frame.startsWith('/message')),
        'announce a message endpoint for the session',
      )
      return { frames, endpoint: frames.find((f) => f.startsWith('/message'))! }
    }

    const asking = await connect()
    const bystander = await connect()

    // Only one of the two sessions sends anything at all.
    await fetch(`http://127.0.0.1:${port}${asking.endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4242, method: 'tools/list' }),
    })
    const carriesTheReply = (frames: string[]) =>
      frames.some((frame) => frame.includes('"id":4242'))
    await gateway.waitFor(
      () => carriesTheReply(asking.frames),
      'deliver the reply to the session that asked',
    )

    assert.ok(
      carriesTheReply(asking.frames),
      'the session that sent the request receives its reply',
    )
    assert.equal(
      carriesTheReply(bystander.frames),
      false,
      'a session that sent nothing must not receive another session’s reply',
    )
  },
)
