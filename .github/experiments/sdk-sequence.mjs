// Temporary: which call before it makes a Windows gateway's large result time
// out for the SDK client, as in the battery (tools/list, plain, separators,
// unicode, then large).
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

const prefixes = [
  [],
  ['tools/list'],
  ['plain'],
  ['separators'],
  ['unicode'],
  ['tools/list', 'plain', 'separators', 'unicode'],
]
for (const mode of ['stateless', 'stateful']) {
  for (const prefix of prefixes) {
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
      { env: { ...process.env, BIG_LENGTH: '524288' } },
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
      for (const step of prefix)
        if (step === 'tools/list') await client.listTools()
        else await client.callTool({ name: step, arguments: {} })
      const before = log.length
      const res = await client.callTool(
        { name: 'large', arguments: {} },
        undefined,
        { timeout: 15000 },
      ).catch((e) => {
        console.log(
          log
            .slice(before)
            .split('\n')
            .filter((line) => line.trim())
            .map((line) => line.slice(0, 200))
            .slice(0, 40)
            .join('\n'),
        )
        throw e
      })
      outcome = `ok, ${res.content[0].text.length} characters`
    } catch (e) {
      outcome = `failed: ${e.message}`
    }
    console.log(
      `${mode} after [${prefix.join(', ')}]: ${outcome} in ${Date.now() - started} ms`,
    )
    await client.close().catch(() => {})
    gw.kill()
    await delay(500)
  }
}
process.exit(0)
