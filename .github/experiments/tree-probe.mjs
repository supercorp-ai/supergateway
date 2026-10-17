// Temporary Windows probe: do gateways ending their servers with taskkill /T
// orphan servers, or end processes that are not theirs? Three gateways on one
// machine, as in the soak: a stateful one with one long-lived session, a
// 2026-07-28 one churning requests, and a WebSocket one whose clients come and
// go and whose servers sometimes crash. Every 30 s the whole process table is
// read with parents and start times.
import { spawn, execFileSync } from 'node:child_process'
import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { WebSocket } from 'ws'

const MINUTES = Number(process.env.PROBE_MINUTES ?? 60)
const free = () =>
  new Promise((r) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => r(p))
    })
  })
const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

const gateways = {}
async function gateway(name, args) {
  const port = await free()
  const child = spawn(process.execPath, ['dist/index.js', ...args, '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let ready = false
  let buffer = ''
  const onData = (chunk) => {
    buffer += chunk
    let i
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i)
      buffer = buffer.slice(i + 1)
      if (/Listening on port/.test(line)) ready = true
      if (/Failed to terminate|Reason:|could not be terminated|process failed|Child exited.*code=(?!1,|0,)/.test(line))
        say(`[${name}]`, line.slice(0, 220))
    }
  }
  child.stdout.setEncoding('utf8').on('data', onData)
  child.stderr.setEncoding('utf8').on('data', onData)
  child.on('exit', (code) => say(`[${name}] GATEWAY EXITED ${code}`))
  while (!ready) await delay(50)
  gateways[name] = { pid: child.pid, port, child }
  say(`[${name}] pid ${child.pid} port ${port}`)
  return port
}

const table = () =>
  execFileSync(
    'powershell.exe',
    [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}|{3}|{4}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().Ticks } else { 0 }), $_.Name, $_.CommandLine }",
    ],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 },
  )
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const [pid, ppid, ticks, name, ...rest] = line.split('|')
      return { pid: +pid, ppid: +ppid, ticks: BigInt(ticks || 0), name, cmd: rest.join('|') }
    })

const statefulPort = await gateway('stateful', ['--stdio', 'node tests/helpers/mock-mcp-server.js stdio', '--outputTransport', 'streamableHttp', '--stateful'])
const modernPort = await gateway('modern', ['--stdio', 'node tests/helpers/modern-bridge-peer.mjs', '--outputTransport', 'streamableHttp'])
const wsPort = await gateway('ws', ['--stdio', 'node tests/helpers/soak-peer.mjs', '--outputTransport', 'ws'])

// The long-lived session and its server's PID.
const durable = new Client({ name: 'durable', version: '1' })
await durable.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${statefulPort}/mcp`)))
const before = table()
const durableServer = before.find(
  (p) => p.name === 'node.exe' && /mock-mcp-server/.test(p.cmd) &&
    before.some((q) => q.pid === p.ppid && q.ppid === gateways.stateful.pid),
)
say('durable server', durableServer?.pid, 'under cmd', durableServer?.ppid)

let durableFailures = 0
const deadline = Date.now() + MINUTES * 60000
const loops = []
loops.push((async () => {
  while (Date.now() < deadline) {
    try {
      await durable.callTool({ name: 'add', arguments: { a: 1, b: 2 } })
    } catch (e) {
      durableFailures++
      say('DURABLE CALL FAILED', e.message)
    }
    await delay(2000)
  }
})())
const modernCall = () =>
  fetch(`http://127.0.0.1:${modernPort}/mcp`, {
    method: 'POST',
    signal: AbortSignal.timeout(20000),
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'echo',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'echo', arguments: { text: 'x' }, _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'probe', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {},
      } },
    }),
  }).then((r) => r.text()).catch(() => {})
for (let w = 0; w < 4; w++)
  loops.push((async () => {
    while (Date.now() < deadline) {
      const abort = new AbortController()
      // Some requests are abandoned mid-flight, as the soak's cancellations are.
      const pending = modernCall()
      if (Math.random() < 0.3) setTimeout(() => abort.abort(), 50)
      await pending
    }
  })())
let round = 0
loops.push((async () => {
  while (Date.now() < deadline) {
    round++
    const pair = [new WebSocket(`ws://127.0.0.1:${wsPort}/message`), new WebSocket(`ws://127.0.0.1:${wsPort}/message`)]
    await Promise.all(pair.map((s) => new Promise((r) => { s.once('open', r); s.once('error', r) })))
    const busy = pair[0]
    const ask = (id, method, params) => new Promise((resolve) => {
      const t = setTimeout(resolve, 10000)
      busy.once('message', () => { clearTimeout(t); resolve() })
      busy.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
    await ask(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'p', version: '1' } })
    if (round % 10 === 5) await ask(2, 'tools/call', { name: 'crash', arguments: {} })
    else await ask(2, 'tools/list', {})
    for (const s of pair) s.terminate()
    await delay(200)
  }
})())

// The watch: orphans, stale parent links, the durable server.
const seen = new Set()
loops.push((async () => {
  while (Date.now() < deadline + 30000) {
    await delay(30000)
    let rows
    try { rows = table() } catch (e) { say('table failed', e.message); continue }
    const byPid = new Map(rows.map((p) => [p.pid, p]))
    const ours = rows.filter((p) => /mock-mcp-server|modern-bridge-peer|soak-peer/.test(p.cmd))
    const orphans = ours.filter((p) => {
      const parent = byPid.get(p.ppid)
      return !parent || parent.ticks > p.ticks
    })
    const alive = durableServer && byPid.has(durableServer.pid)
    say(`round ${round}: servers ${ours.length}, orphans ${orphans.length}, durable server ${alive ? 'alive' : 'GONE'}, durable failures ${durableFailures}`)
    for (const o of orphans) {
      const key = `${o.pid}:${o.ticks}`
      if (seen.has(key)) continue
      seen.add(key)
      const parent = byPid.get(o.ppid)
      say(`  ORPHAN pid ${o.pid} ${o.name} parent ${o.ppid} ${parent ? `is newer: ${parent.name} ${parent.cmd.slice(0, 80)}` : 'gone'} | ${o.cmd.slice(0, 120)}`)
    }
  }
})())
await Promise.all(loops)
say('done; durable failures', durableFailures)
for (const g of Object.values(gateways)) g.child.kill()
await delay(3000)
const left = table().filter((p) => /mock-mcp-server|modern-bridge-peer|soak-peer/.test(p.cmd))
say('servers left after the gateways ended:', left.length, left.map((p) => p.pid).join(' '))
process.exit(0)
