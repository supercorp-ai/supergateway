// Temporary: whether the Windows battery's large-result timeout follows the
// SDK client, or how run-battery starts the gateway (preload + IPC channel).
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const free = () =>
  new Promise((r) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => r(p))
    })
  })
const preload = fileURLToPath(
  new URL('../../tests/helpers/windows-console-signals.cjs', import.meta.url),
)
const BIG_LENGTH = '524288'

for (const launch of ['plain', 'preload+ipc', 'ipc only', 'stdout unread']) {
  for (const mode of ['stateless', 'stateful']) {
    const port = await free()
    const gw = spawn(
      process.execPath,
      [
        ...(launch === 'preload+ipc' ? ['--require', preload] : []),
        'dist/index.js',
        '--stdio',
        'node tests/clients/battery-peer.mjs',
        '--outputTransport',
        'streamableHttp',
        '--port',
        String(port),
        ...(mode === 'stateful' ? ['--stateful'] : []),
      ],
      {
        stdio: launch.includes('ipc')
          ? ['pipe', 'pipe', 'pipe', 'ipc']
          : 'pipe',
        env: { ...process.env, BIG_LENGTH },
      },
    )
    let log = ''
    const read = (c) => (log += c)
    gw.stdout.on('data', read)
    gw.stderr.on('data', read)
    while (!/Listening on port/.test(log)) await delay(50)
    if (launch === 'stdout unread') {
      gw.stdout.off('data', read)
      gw.stderr.off('data', read)
      gw.stdout.pause()
      gw.stderr.pause()
    }
    const started = Date.now()
    const result = spawnSync(
      process.execPath,
      ['tests/clients/battery.mjs', `http://127.0.0.1:${port}/mcp`, 'http'],
      {
        encoding: 'utf8',
        timeout: 90000,
        env: { ...process.env, BIG_LENGTH, BATTERY_TRACE: '1' },
      },
    )
    const big = (result.stderr.match(/^.*1 MB result.*$/m) ?? ['(none)'])[0]
    console.log(
      `${launch} / ${mode}: ${big} (${Date.now() - started} ms${result.error ? `, ${result.error.code}` : ''})`,
    )
    gw.kill()
    await delay(500)
  }
}
process.exit(0)
