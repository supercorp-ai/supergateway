import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { faultControl } from './helpers/fault-control.js'
import {
  initialize,
  launchGateway,
  unusedPort,
} from './helpers/gateway-process.js'

// Raw node:http lets the test stop reading the socket itself. Fetch/SDK clients
// can continue draining into an internal buffer after application reads stop.
async function stream(t: TestContext, base: string) {
  const request = get(`${base}/sse`)
  t.after(() => request.destroy())
  const response = await new Promise<import('node:http').IncomingMessage>(
    (resolve, reject) => {
      request.once('response', resolve)
      request.once('error', reject)
    },
  )
  response.on('error', () => {}) // Assertions below report gateway/stream failure.
  let buffer = '',
    endpoint = '',
    count = 0
  const replies = new Map<number, any>()
  response.setEncoding('utf8').on('data', (chunk: string) => {
    buffer += chunk
    let end: number
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const event = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      const data = event
        .split('\n')
        .find((line) => line.startsWith('data:'))
        ?.slice(5)
        .trim()
      if (!data) continue
      if (event.startsWith('event: endpoint')) endpoint = data
      else {
        const message = JSON.parse(data)
        if (message.method === 'notifications/message') {
          assert.equal(
            message.params.logger,
            String(count++),
            'no skipped, repeated, or reordered notifications',
          )
          assert.equal(message.params.data, 'x'.repeat(16384))
        } else if (typeof message.id === 'number')
          replies.set(message.id, message)
      }
    }
  })
  const wait = async (
    predicate: () => boolean,
    description: string,
    ms = 15000,
  ) => {
    const deadline = Date.now() + ms
    while (!predicate()) {
      assert.ok(
        !response.destroyed && Date.now() < deadline,
        `${description}; stream closed=${response.destroyed}`,
      )
      await delay(10)
    }
  }
  await wait(() => Boolean(endpoint), 'receive SSE endpoint')
  const post = async (message: object) => {
    const result = await fetch(new URL(endpoint, base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(3000),
    })
    await result.text()
    assert.equal(result.status, 202)
  }
  return { response, replies, wait, post, count: () => count }
}

for (const paused of [false, true]) {
  test(
    `SSE ${paused ? 'paused' : 'draining'} reader survives 128 MiB of small valid notifications with a 96 MiB gateway heap`,
    { timeout: 90000 },
    async (t) => {
      const control = await faultControl(t)
      const port = await unusedPort()
      const gateway = launchGateway(
        t,
        [
          '--stdio',
          'exec node tests/helpers/fault-peer.mjs',
          '--outputTransport',
          'sse',
          '--port',
          String(port),
          '--logLevel',
          'none',
          '--healthEndpoint',
          '/health',
        ],
        {
          NODE_OPTIONS: '--max-old-space-size=96',
          FAULT_CONTROL: control.url,
        },
      )
      const base = `http://127.0.0.1:${port}`
      const deadline = Date.now() + 8000
      while (true) {
        try {
          const response = await fetch(`${base}/health`, {
            signal: AbortSignal.timeout(250),
          })
          assert.equal(await response.text(), 'ok')
          break
        } catch (error) {
          if (Date.now() > deadline || gateway.child.exitCode !== null)
            throw new Error(
              `Gateway health check failed:\n${gateway.output()}\n${gateway.errors()}`,
              { cause: error },
            )
          await delay(20)
        }
      }
      const slow = await stream(t, base),
        healthy = await stream(t, base)
      await slow.post(initialize(1))
      await slow.wait(() => slow.replies.has(1), 'initialize peer')
      await slow.post({ jsonrpc: '2.0', method: 'notifications/initialized' })
      await healthy.post(initialize(10))
      await healthy.wait(
        () => healthy.replies.has(10),
        'initialize healthy client',
      )
      const healthyPid = Number(
        healthy.replies.get(10).result.serverInfo.version,
      )
      assert.notEqual(
        healthyPid,
        Number(slow.replies.get(1).result.serverInfo.version),
        'SSE sessions own separate children',
      )
      await healthy.post({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      })
      if (paused) slow.response.pause()
      await slow.post({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'burst', arguments: { count: 8192 } },
      })
      await control.wait('burst-start')
      // A finite pause permits backpressure, disconnection, or delivery after
      // resumption. It does not require unlimited queuing or one specific policy.
      if (paused) {
        const controller = new AbortController()
        try {
          await Promise.race([
            gateway.exited,
            delay(6000, undefined, { signal: controller.signal }),
          ])
        } finally {
          controller.abort()
        }
        assert.equal(gateway.child.exitCode, null, gateway.errors())
        assert.equal(gateway.child.signalCode, null, gateway.errors())
        slow.response.resume()
      }
      await healthy.post({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'identity', arguments: {} },
      })
      await healthy.wait(
        () => healthy.replies.has(3),
        'independent client remains responsive during another client’s burst',
      )
      assert.equal(healthy.count(), 0, 'no notifications cross sessions')
      assert.equal(
        JSON.parse(healthy.replies.get(3).result.content[0].text).pid,
        healthyPid,
      )
      // The peer reports the burst done once the gateway has read all of it.
      // When this failed under machine load it was never a slow burst (those
      // took under 0.6 s): the gateway had died of heap exhaustion mid-burst,
      // queueing notifications for a reader that fell behind (GW-033). Say so,
      // rather than report a missing burst-done five seconds later.
      await Promise.race([
        control.wait('burst-done'),
        gateway.exited.then(({ code, signal }) => {
          throw Error(
            `The gateway exited (${signal ?? `code ${code}`}) during the burst, ` +
              `after the ${paused ? 'paused' : 'draining'} reader got ` +
              `${slow.count()} of 8192 notifications. A reader that falls ` +
              `behind still makes the gateway queue its output (GW-033).\n` +
              gateway.errors().slice(-2000),
          )
        }),
      ])
      if (!paused || !slow.response.destroyed) {
        if (paused) {
          const deadline = Date.now() + 15000
          while (
            !slow.response.destroyed &&
            !slow.replies.has(2) &&
            Date.now() < deadline
          )
            await delay(10)
          assert.ok(
            slow.response.destroyed || slow.replies.has(2),
            'slow stream must close or resume progress',
          )
        } else
          await slow.wait(
            () => slow.replies.has(2),
            'draining client receives final result',
          )
        if (slow.replies.has(2)) assert.equal(slow.count(), 8192)
      }
      assert.equal(gateway.child.exitCode, null, gateway.errors())
    },
  )
}
