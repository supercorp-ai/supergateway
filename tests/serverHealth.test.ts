import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Request, Response } from 'express'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { ChildOwner, StartPeer } from '../src/lib/childHandoff.js'
import {
  HEALTH_INTERVAL_MS,
  PROBE_TIMEOUT_MS,
  ServerHealth,
  healthHandler,
  probeServer,
  serverHealthOf,
  type Health,
} from '../src/lib/serverHealth.js'
import { enableFakeTimers } from './helpers/fake-timers.js'

// --healthCheck server (#83): the probe, its cache, and the endpoint's answer,
// against a peer the test plays.

// A peer the test answers for: what was written to it, whether it was
// stopped, and the owner it reports to.
function fakePeer() {
  const written: JSONRPCMessage[] = []
  let stops = 0
  let owner!: ChildOwner
  const start: StartPeer = (given) => {
    owner = given
    return {
      write: (message) => written.push(message),
      end: () => {},
      stop: async () => {
        stops++
      },
      gone: false,
    }
  }
  return {
    start,
    written,
    stops: () => stops,
    owner: () => owner,
    // Answers the last request written, as the server would.
    answer: (result: unknown = {}) => {
      const { id } = written.at(-1) as { id: string }
      owner.message({ jsonrpc: '2.0', id, result }, '')
    },
  }
}

const turn = () => new Promise((resolve) => setImmediate(resolve))

test('a server that answers initialize and ping is healthy, and is stopped', async () => {
  const peer = fakePeer()
  const probed = probeServer(peer.start)
  assert.equal(peer.written.length, 1)
  assert.deepEqual(peer.written[0], {
    jsonrpc: '2.0',
    id: 'supergateway-health-initialize',
    method: 'initialize',
    params: {
      protocolVersion: (peer.written[0] as any).params.protocolVersion,
      capabilities: {},
      clientInfo: {
        name: 'supergateway-health',
        version: (peer.written[0] as any).params.clientInfo.version,
      },
    },
  })
  assert.match((peer.written[0] as any).params.protocolVersion, /^\d{4}-/)
  peer.answer()
  assert.deepEqual(peer.written.slice(1), [
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 'supergateway-health-ping', method: 'ping' },
  ])
  assert.equal(peer.stops(), 0, 'not stopped before it answers ping')
  peer.answer()
  assert.deepEqual(await probed, { ok: true })
  assert.equal(peer.stops(), 1)
})

test('what the server says besides the answers is ignored', async () => {
  const peer = fakePeer()
  const probed = probeServer(peer.start)
  const owner = peer.owner()
  // A request and a notification from the server, an answer to something it
  // was not asked, and output that is not JSON-RPC at all.
  owner.message({ jsonrpc: '2.0', id: 7, method: 'roots/list' }, '')
  owner.message({ jsonrpc: '2.0', method: 'notifications/message' }, '')
  owner.message({ jsonrpc: '2.0', id: 'other', result: {} }, '')
  owner.message({ jsonrpc: '2.0', result: {} }, '')
  owner.nonJson('starting up')
  owner.stderr('a warning')
  assert.equal(owner.output(), undefined)
  assert.equal(peer.written.length, 1, 'still waiting for initialize')
  peer.answer()
  peer.answer()
  assert.deepEqual(await probed, { ok: true })
})

test('a server that refuses initialize is unhealthy, with its error', async () => {
  const peer = fakePeer()
  const probed = probeServer(peer.start)
  peer.owner().message(
    {
      jsonrpc: '2.0',
      id: 'supergateway-health-initialize',
      error: { code: -32600, message: 'unsupported version' },
    },
    '',
  )
  assert.deepEqual(await probed, {
    ok: false,
    reason: 'the server refused: unsupported version',
  })
  assert.equal(peer.stops(), 1)
  assert.equal(peer.written.length, 1, 'no ping after a refusal')
})

test('a server that exits is unhealthy, and only the first reason counts', async () => {
  const peer = fakePeer()
  const probed = probeServer(peer.start)
  peer.owner().exit(1, null)
  peer.owner().exit(null, 'SIGTERM')
  peer.owner().failure('process', Error('late'))
  assert.deepEqual(await probed, {
    ok: false,
    reason: 'the server exited (code=1, signal=null)',
  })
  assert.equal(peer.stops(), 1, 'stopped once')
})

test('a failure is unhealthy, with its cause when it has one', async () => {
  const peer = fakePeer()
  const probed = probeServer(peer.start)
  peer
    .owner()
    .failure(
      'upstream',
      Error('fetch failed', { cause: Error('connect ECONNREFUSED') }),
    )
  assert.deepEqual(await probed, {
    ok: false,
    reason: 'the server failed: fetch failed (connect ECONNREFUSED)',
  })

  const other = fakePeer()
  const without = probeServer(other.start)
  other
    .owner()
    .failure('stdin', Error('write EPIPE', { cause: 'not an error' }))
  assert.deepEqual(await without, {
    ok: false,
    reason: 'the server failed: write EPIPE',
  })
})

test('a server that does not answer in time is unhealthy', async (t) => {
  enableFakeTimers(t)
  const peer = fakePeer()
  const probed = probeServer(peer.start)
  peer.answer()
  t.mock.timers.tick(PROBE_TIMEOUT_MS - 1)
  await turn()
  assert.equal(peer.stops(), 0)
  t.mock.timers.tick(1)
  assert.deepEqual(await probed, {
    ok: false,
    reason: 'no answer within 10s',
  })
  assert.equal(peer.stops(), 1)
  // Answered too late, it changes nothing.
  peer.answer()
  assert.equal(peer.stops(), 1)
})

test('the timeout is the caller’s to set', async (t) => {
  enableFakeTimers(t)
  const probed = probeServer(fakePeer().start, 2500)
  t.mock.timers.tick(2500)
  assert.deepEqual(await probed, {
    ok: false,
    reason: 'no answer within 2.5s',
  })
})

test('an answer stands for the interval, and one probe runs at a time', async () => {
  let now = 1000
  const results: Health[] = [
    { ok: true },
    { ok: false, reason: 'down' },
    { ok: false, reason: 'still down' },
    { ok: true },
  ]
  let probes = 0
  let release!: () => void
  const probe = async () => {
    probes++
    await new Promise<void>((resolve) => (release = resolve))
    return results.shift()!
  }
  const logs: string[] = []
  const logger = {
    info: (line: string) => logs.push(`info ${line}`),
    error: (line: string) => logs.push(`error ${line}`),
  }
  const health = new ServerHealth(probe, logger, 5000, () => now)

  const first = health.check()
  const second = health.check()
  assert.equal(probes, 1, 'asked twice while probing, probed once')
  release()
  assert.deepEqual(await first, { ok: true })
  assert.deepEqual(await second, { ok: true })

  now += 4999
  assert.deepEqual(await health.check(), { ok: true })
  assert.equal(probes, 1, 'cached within the interval')

  now += 1
  const down = health.check()
  assert.equal(probes, 2, 'probed again once it has passed')
  release()
  assert.deepEqual(await down, { ok: false, reason: 'down' })

  now += 5000
  const still = health.check()
  release()
  assert.deepEqual(await still, { ok: false, reason: 'still down' })

  now += 5000
  const back = health.check()
  release()
  assert.deepEqual(await back, { ok: true })

  // Logged when it changes, not on every probe.
  assert.deepEqual(logs, [
    'error Health check: the server is unhealthy: down',
    'info Health check: the server is healthy again',
  ])
})

test('a server unhealthy from the first probe is logged once', async () => {
  const logs: string[] = []
  const health = new ServerHealth(
    async () => ({ ok: false, reason: 'never started' }),
    { info: () => logs.push('info'), error: (line: string) => logs.push(line) },
  )
  assert.deepEqual(await health.check(), {
    ok: false,
    reason: 'never started',
  })
  assert.deepEqual(logs, [
    'Health check: the server is unhealthy: never started',
  ])
})

test('the default interval is ten seconds of Date.now', async (t) => {
  enableFakeTimers(t, ['Date'])
  assert.equal(HEALTH_INTERVAL_MS, 10_000)
  let probes = 0
  const health = new ServerHealth(
    async () => {
      probes++
      return { ok: true }
    },
    { info: () => {}, error: () => {} },
  )
  await health.check()
  t.mock.timers.tick(HEALTH_INTERVAL_MS - 1)
  await health.check()
  assert.equal(probes, 1)
  t.mock.timers.tick(1)
  await health.check()
  assert.equal(probes, 2)
})

// A response that records what the handler did with it.
function fakeResponse() {
  const seen: { status?: number; body?: string; before?: boolean } = {}
  const res = {
    status(code: number) {
      seen.status = code
      return res
    },
    send(body: string) {
      seen.body = body
      return res
    },
  }
  return { res: res as unknown as Response, seen }
}

const req = {} as Request

test('a health endpoint without a server to check answers ok', async () => {
  const { res, seen } = fakeResponse()
  await healthHandler(undefined)(req, res)
  assert.deepEqual(seen, { body: 'ok' })
})

test('a health endpoint answers ok, or 503 with the reason', async () => {
  const quiet = { info: () => {}, error: () => {} }
  const healthy = new ServerHealth(async () => ({ ok: true }), quiet)
  const ok = fakeResponse()
  await healthHandler(healthy)(req, ok.res)
  assert.deepEqual(ok.seen, { body: 'ok' })

  const unhealthy = new ServerHealth(
    async () => ({
      ok: false,
      reason: 'the server exited (code=1, signal=null)',
    }),
    quiet,
  )
  const down = fakeResponse()
  await healthHandler(unhealthy)(req, down.res)
  assert.deepEqual(down.seen, {
    status: 503,
    body: 'unhealthy: the server exited (code=1, signal=null)',
  })
})

test('a health endpoint runs `before` first, healthy or not', async () => {
  for (const health of [
    undefined,
    new ServerHealth(async () => ({ ok: false, reason: 'down' }), {
      info: () => {},
      error: () => {},
    }),
  ]) {
    const { res, seen } = fakeResponse()
    await healthHandler(health, () => {
      assert.equal(seen.body, undefined, 'before anything is sent')
      seen.before = true
    })(req, res)
    assert.equal(seen.before, true)
  }
})

test('--healthCheck gateway checks no server', () => {
  const start = () => {
    throw Error('must not start a server')
  }
  const logger = { info: () => {}, error: () => {} }
  assert.equal(
    serverHealthOf('gateway', { closing: false }, start, logger),
    undefined,
  )
  assert.equal(
    serverHealthOf(undefined, { closing: false }, start, logger),
    undefined,
  )
})

test('--healthCheck server starts a server per probe, with errors left out of the log', async () => {
  const infos: unknown[] = []
  const errors: unknown[] = []
  const logger = {
    info: (...args: unknown[]) => infos.push(args),
    error: (...args: unknown[]) => errors.push(args),
  }
  const peer = fakePeer()
  let given: typeof logger | undefined
  const health = serverHealthOf(
    'server',
    { closing: false },
    (quiet) => {
      given = quiet as typeof logger
      return peer.start
    },
    logger,
  )!
  const checked = health.check()
  peer.answer()
  peer.answer()
  assert.deepEqual(await checked, { ok: true })

  given!.info('said')
  given!.error('dropped', Error('trace'))
  assert.deepEqual(infos, [['said']])
  assert.deepEqual(errors, [])
})

test('a gateway shutting down starts no server and is unhealthy', async () => {
  const errors: string[] = []
  const health = serverHealthOf(
    'server',
    { closing: true },
    () => {
      throw Error('must not start a server')
    },
    { info: () => {}, error: (line: string) => errors.push(line) },
  )!
  assert.deepEqual(await health.check(), {
    ok: false,
    reason: 'the gateway is shutting down',
  })
  assert.deepEqual(errors, [
    'Health check: the server is unhealthy: the gateway is shutting down',
  ])
})
