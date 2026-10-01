import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { faultControl } from './helpers/fault-control.js'
import {
  gatewayTimeout,
  initialize,
  launchGateway,
  unusedPort,
} from './helpers/gateway-process.js'

// GW-033 for the bridges. A stdio client of `--sse` or `--streamableHttp`
// that stops reading must hold the upstream server's output, the way a slow
// HTTP client of the gateway does, instead of the bridge reading everything
// upstream sends and queueing it behind a stdout nobody reads (a 128 MiB burst
// left a bridge at about 440 MiB). With the hold the stall reaches all the way
// back: the bridge stops reading the response, the upstream gateway stops
// reading its server, and the server's own writes wait, so its burst cannot
// finish until the client reads again.
const COUNT = 2048
const HELD_FOR = 1500

const bridges = {
  '--sse': { upstream: [], path: '/sse' },
  '--streamableHttp': {
    upstream: ['--outputTransport', 'streamableHttp', '--stateful'],
    path: '/mcp',
  },
}

for (const [flag, { upstream, path }] of Object.entries(bridges)) {
  test(
    `${flag} bridge: a stdio client that stops reading holds the upstream server's output until it reads again`,
    { timeout: gatewayTimeout(90000) },
    async (t) => {
      const control = await faultControl(t)
      const port = await unusedPort()
      const gateway = launchGateway(
        t,
        [
          '--stdio',
          'exec node tests/helpers/fault-peer.mjs',
          ...upstream,
          '--port',
          String(port),
          '--logLevel',
          'none',
          '--healthEndpoint',
          '/health',
        ],
        { FAULT_CONTROL: control.url },
      )
      const base = `http://127.0.0.1:${port}`
      for (;;) {
        const up = await fetch(base + '/health', {
          signal: AbortSignal.timeout(250),
        })
          .then((response) => response.ok)
          .catch(() => false)
        if (up) break
        assert.equal(gateway.child.exitCode, null, gateway.errors())
        await delay(20)
      }

      // Started directly: the test has to be able to stop reading its stdout.
      const bridge = spawn(
        process.execPath,
        [
          process.env.SUPERGATEWAY_TEST_ENTRY ?? 'dist/index.js',
          flag,
          base + path,
          '--logLevel',
          'none',
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      )
      t.after(() => bridge.kill('SIGKILL'))
      let errors = ''
      bridge.stderr.setEncoding('utf8').on('data', (chunk) => (errors += chunk))
      let seq = 0
      let answered = false
      let initialized = false
      let buffer = ''
      bridge.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        buffer += chunk
        let end: number
        while ((end = buffer.indexOf('\n')) >= 0) {
          const message = JSON.parse(buffer.slice(0, end))
          buffer = buffer.slice(end + 1)
          if (message.id === 1) initialized = true
          else if (message.id === 'burst') answered = true
          else if (message.method === 'notifications/message')
            assert.equal(
              message.params.logger,
              String(seq++),
              'in order, once each',
            )
        }
      })
      const send = (message: object) =>
        bridge.stdin.write(JSON.stringify(message) + '\n')
      const deadline = Date.now() + 15000
      send(initialize(1))
      while (!initialized) {
        assert.ok(Date.now() < deadline, `bridge never initialized: ${errors}`)
        await delay(20)
      }
      send({ jsonrpc: '2.0', method: 'notifications/initialized' })

      bridge.stdout.pause()
      send({
        jsonrpc: '2.0',
        id: 'burst',
        method: 'tools/call',
        params: { name: 'burst', arguments: { count: COUNT } },
      })
      await control.wait('burst-start', undefined, 10000)
      await delay(HELD_FOR)
      assert.ok(
        !control.events.some((event) => event.kind === 'burst-done'),
        `the server finished writing ${COUNT} × 16 KiB while the bridge's client read ${seq} of them: the bridge queued the rest`,
      )

      bridge.stdout.resume()
      await control.wait('burst-done', undefined, 30000)
      const until = Date.now() + 30000
      while (!answered && Date.now() < until) await delay(10)
      assert.equal(seq, COUNT)
      assert.ok(answered, 'the call is answered after the burst')
      assert.equal(bridge.exitCode, null, errors)
      assert.equal(gateway.child.exitCode, null, gateway.errors())
    },
  )
}
