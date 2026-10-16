// Temporary: at what size a tool result over Streamable HTTP stops arriving,
// read over plain HTTP (no SDK client), with the gateway's debug log.
import { spawn } from 'node:child_process'
import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

const free = () =>
  new Promise((r) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => r(p))
    })
  })

for (const stateful of [false, true]) {
  for (const size of [16384, 65536, 131072, 262144, 524288]) {
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
        ...(stateful ? ['--stateful'] : []),
      ],
      { env: { ...process.env, BIG_LENGTH: String(size) } },
    )
    let log = ''
    gw.stdout.on('data', (c) => (log += c))
    gw.stderr.on('data', (c) => (log += c))
    while (!/Listening on port/.test(log)) await delay(50)
    const post = async (body, session) => {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        signal: AbortSignal.timeout(20000),
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(session ? { 'mcp-session-id': session } : {}),
        },
        body: JSON.stringify(body),
      })
      let got = 0
      const reader = res.body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          got += value.length
        }
      } catch (e) {
        return { res, got, error: e.name }
      }
      return { res, got }
    }
    const started = Date.now()
    let outcome
    try {
      const init = await post({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'probe', version: '1' },
        },
      })
      const session = init.res.headers.get('mcp-session-id') ?? undefined
      if (stateful)
        await post(
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          session,
        )
      const big = await post(
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'large', arguments: {} },
        },
        session,
      )
      outcome = `status ${big.res.status}, ${big.res.headers.get('content-type')}, ${big.got} bytes${big.error ? `, then ${big.error}` : ''}`
    } catch (e) {
      outcome = `error ${e.name}: ${e.message}`
    }
    console.log(
      `${stateful ? 'stateful' : 'stateless'} ${size}: ${outcome} in ${Date.now() - started} ms`,
    )
    if (!/status 200.*bytes$/.test(outcome) || Date.now() - started > 5000)
      console.log(
        log
          .split('\n')
          .map((line) => line.slice(0, 240))
          .slice(-40)
          .join('\n'),
      )
    gw.kill()
    await delay(500)
  }
}
process.exit(0)
