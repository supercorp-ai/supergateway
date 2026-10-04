import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import express from 'express'
import { gatewayTimeout, unusedPort } from './helpers/gateway-process.js'

// A request the gateway never answers fails the test instead of hanging it.
const options = { timeout: gatewayTimeout(10000) }

// Several servers on one port, in process: which server a request reaches,
// what the gateway answers itself, and what its shutdown stops.

const mounted = (path: string, name: string) => {
  const app = express()
  app.get(`${path === '/' ? '' : path}/hello`, (_req, res) => {
    res.send(name)
  })
  return app
}

test('a request reaches the server with the longest path that holds it', async () => {
  const { mountFor } = await import('../src/lib/serve.js')
  const mounts = [
    { path: '/' },
    { path: '/git' },
    { path: '/git/hub' },
    { path: '/fs' },
  ]
  const owner = (path: string) => mountFor(mounts, path)?.path
  // map: longest prefix, by whole segments
  assert.equal(owner('/git'), '/git')
  assert.equal(owner('/git/sse'), '/git')
  assert.equal(owner('/git/hub/mcp'), '/git/hub')
  assert.equal(owner('/github/sse'), '/')
  assert.equal(owner('/fs/mcp'), '/fs')
  assert.equal(owner('/elsewhere'), '/')
  // map: without a root server, a path nobody holds has no owner
  assert.equal(mountFor(mounts.slice(1), '/github/sse'), undefined)
  assert.equal(mountFor([], '/git'), undefined)
  // map: a shorter path listed later doesn't take it back
  assert.equal(
    mountFor([{ path: '/git' }, { path: '/' }], '/git/sse')?.path,
    '/git',
  )
})

test('a URL another server or the health endpoint would receive is a conflict', async () => {
  const { routeConflict } = await import('../src/lib/serve.js')
  const one = {
    name: 'one',
    path: '/one',
    routes: ['/one/sse', '/one/message'],
  }
  const root = { name: 'root', path: '/', routes: ['/sse', '/message'] }
  const sse = { name: 'sse', path: '/sse', routes: ['/sse/mcp'] }
  // map: no conflict
  assert.equal(routeConflict([one, sse], ['/healthz']), undefined)
  assert.equal(routeConflict([], ['/healthz']), undefined)
  // map: another server's path holds the URL
  assert.equal(
    routeConflict([root, sse], []),
    '"root" serves /sse, but "sse" at /sse would receive it. Give one of them a different "path"',
  )
  // map: the gateway's health endpoint answers the URL
  assert.equal(
    routeConflict([one, sse], ['/one/message']),
    '"one" serves /one/message, which is also the gateway\'s health endpoint',
  )
})

test(
  'several servers share the port: health, routing, 404, upgrades and shutdown',
  options,
  async (t) => {
    let cleanup: (() => Promise<void>) | undefined
    t.mock.module(new URL('../src/lib/onSignals.js', import.meta.url).href, {
      namedExports: {
        onSignals: (given: { cleanup: () => Promise<void> }) => {
          cleanup = given.cleanup
        },
      },
    })
    const { serve } = await import('../src/lib/serve.js?shared')
    const info: unknown[][] = []
    const closed: string[] = []
    const upgrades: string[] = []
    const socket =
      (name: string) =>
      (req: { url?: string }, sock: import('node:stream').Duplex) => {
        upgrades.push(`${name} ${req.url}`)
        sock.end('HTTP/1.1 418 Teapot\r\nConnection: close\r\n\r\n')
      }
    const mount = (path: string, name: string, ws?: string) => ({
      app: mounted(path, name),
      path,
      ...(ws ? { upgrade: { path: ws, handle: socket(name) } } : {}),
      listening: (host: string | undefined, port: number) =>
        info.push([name, host, port]),
      close: async () => {
        closed.push(name)
      },
    })
    const port = await unusedPort()
    const server = serve({
      port,
      host: '127.0.0.1',
      logger: { info: (...args) => info.push(args), error() {} },
      mounts: [
        mount('/', 'root'),
        mount('/a', 'a', '/a/ws'),
        mount('/b', 'b', '/b/ws'),
      ],
      healthEndpoints: ['/healthz'],
    })
    const get = (path: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        request({ port, host: '127.0.0.1', path }, (res) => {
          let body = ''
          res.on('data', (chunk) => (body += chunk))
          res.on('end', () => resolve({ status: res.statusCode!, body }))
        })
          .on('error', reject)
          .end()
      })
    const upgrade = (path: string) =>
      new Promise<number>((resolve, reject) => {
        request({
          port,
          host: '127.0.0.1',
          path,
          headers: { Connection: 'Upgrade', Upgrade: 'websocket' },
        })
          .on('upgrade', (res) => resolve(res.statusCode!))
          .on('response', (res) => resolve(res.statusCode!))
          .on('error', reject)
          .end()
      })
    for (let i = 0; i < 100 && info.length < 4; i++)
      await new Promise((resolve) => setTimeout(resolve, 20))
    t.after(() => server.close())

    // map: listening is logged once, then each server's URLs
    assert.deepEqual(info, [
      [`Listening on port ${port}`],
      ['root', '127.0.0.1', port],
      ['a', '127.0.0.1', port],
      ['b', '127.0.0.1', port],
    ])
    // map: the gateway's health endpoint, ahead of every server
    assert.deepEqual(await get('/healthz'), { status: 200, body: 'ok' })
    // map: each request reaches its own server
    assert.deepEqual(await get('/hello'), { status: 200, body: 'root' })
    assert.deepEqual(await get('/a/hello'), { status: 200, body: 'a' })
    assert.deepEqual(await get('/b/hello?x=1'), { status: 200, body: 'b' })
    // map: a request its server doesn't route gets Express's 404
    assert.equal((await get('/a/nothing')).status, 404)

    // map: an upgrade goes to the server whose WebSocket path it names, and
    // one for no such path to the first, which refuses it as ws would
    assert.equal(await upgrade('/b/ws?token=1'), 418)
    assert.equal(await upgrade('/a/ws'), 418)
    assert.equal(await upgrade('/nowhere'), 418)
    assert.deepEqual(upgrades, ['b /b/ws?token=1', 'a /a/ws', 'a /nowhere'])

    // map: the shutdown stops every server
    await cleanup!()
    assert.deepEqual(closed.sort(), ['a', 'b', 'root'])
  },
)

test(
  'without a root server, a path no server holds gets the 404',
  options,
  async (t) => {
    t.mock.module(new URL('../src/lib/onSignals.js', import.meta.url).href, {
      namedExports: { onSignals() {} },
    })
    const { serve } = await import('../src/lib/serve.js?unheld')
    const port = await unusedPort()
    let ready!: () => void
    const listening = new Promise<void>((resolve) => (ready = resolve))
    const server = serve({
      port,
      host: '127.0.0.1',
      logger: { info() {}, error() {} },
      mounts: [
        {
          app: mounted('/a', 'a'),
          path: '/a',
          listening: () => ready(),
          close: async () => {},
        },
      ],
      healthEndpoints: [],
    })
    await listening
    t.after(() => server.close())
    const status = await new Promise<number>((resolve, reject) => {
      request({ port, host: '127.0.0.1', path: '/b/hello' }, (res) => {
        res.resume()
        resolve(res.statusCode!)
      })
        .on('error', reject)
        .end()
    })
    // map: unheld path
    assert.equal(status, 404)
  },
)
