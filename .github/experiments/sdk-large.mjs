// Temporary: the SDK client asking a Windows gateway for a large result, with
// the gateway's debug log, to see where the reply stops.
import { spawn } from 'node:child_process'
import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const free = () =>
  new Promise((r) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => r(p))
    })
  })

for (const size of [65536, 131072, 262144, 524288]) {
  for (const mode of ['stateless', 'stateful']) {
    const port = await free()
    const gw = spawn(
      process.execPath,
      [
        'dist/index.js',
        '--stdio',
        'node tests/clients/battery-peer.mjs',
        '--outputTransport',
        'streamableHttp',
        '--port',
        String(port),
        '--logLevel',
        'debug',
        ...(mode === 'stateful' ? ['--stateful'] : []),
      ],
      { env: { ...process.env, BIG_LENGTH: String(size) } },
    )
    let log = ''
    gw.stdout.on('data', (c) => (log += c))
    gw.stderr.on('data', (c) => (log += c))
    while (!/Listening on port/.test(log)) await delay(50)
    const client = new Client({ name: 'probe', version: '1' })
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
    )
    const started = Date.now()
    let outcome
    try {
      await client.connect(transport)
      const res = await client.callTool(
        { name: 'large', arguments: {} },
        undefined,
        { timeout: 15000 },
      )
      outcome = `ok, ${res.content[0].text.length} characters`
    } catch (e) {
      outcome = `failed: ${e.message}`
    }
    console.log(`${mode} ${size}: ${outcome} in ${Date.now() - started} ms`)
    if (outcome.startsWith('failed'))
      console.log(
        log
          .split('\n')
          .filter((line) => !/^\s*$/.test(line))
          .map((line) => line.slice(0, 200))
          .slice(-30)
          .join('\n'),
      )
    await client.close().catch(() => {})
    gw.kill()
    await delay(500)
  }
}
process.exit(0)
