import assert from 'node:assert/strict'
import {
  launchGateway,
  peerCommand,
  unusedPort,
} from './helpers/gateway-process.js'
import { knownBugTest } from './helpers/known-bug.js'

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
 * The half of GW-017 that is still open.
 *
 * Per-session `Server` instances fixed the crash — a second client connects,
 * and so does a reconnecting one. They did not fix this: `stdioToSse` runs one
 * child for the whole process and writes every line it prints to every
 * connected session, so a client that asked nothing still receives another
 * client's replies.
 *
 * Routing replies needs the gateway to rewrite ids, because two clients both
 * numbering from zero collide on the child's single stdin. And routing alone
 * would not settle #35: one child means one *state*, so two clients driving a
 * browser or a filesystem server still interfere whatever the envelopes say.
 * That is an architecture decision rather than a patch, so this stays red and
 * honest instead of being quietly narrowed.
 */
knownBugTest(
  'GW-017',
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
