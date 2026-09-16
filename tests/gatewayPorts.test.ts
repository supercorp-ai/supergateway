import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, Server } from 'node:net'

// Real sockets distinguish IPv4 loopback availability from the gateway's
// wildcard bind. Only candidate selection is controlled.
test('gateway port allocation skips IPv6 listeners and previously issued ports', async (t) => {
  const occupied = createServer()
  await new Promise<void>((resolve) =>
    occupied.listen({ port: 0, host: '::', ipv6Only: true }, resolve),
  )
  t.after(() => new Promise<void>((resolve) => occupied.close(() => resolve())))
  const occupiedPort = (occupied.address() as { port: number }).port
  const free = async () => {
    const s = createServer()
    await new Promise<void>((resolve) => s.listen(0, resolve))
    const port = (s.address() as { port: number }).port
    await new Promise<void>((resolve) => s.close(() => resolve()))
    return port
  }
  const first = await free()
  let second = await free()
  while (second === first) second = await free()
  const candidates = [occupiedPort, first, first, second]
  t.mock.module('node:crypto', {
    namedExports: {
      randomInt: (min: number, max: number) => {
        assert.deepEqual(
          [min, max],
          [20000, 32768],
          'avoid the usual outgoing ephemeral port range',
        )
        assert.ok(
          candidates.length,
          'bound retries and never exhaust candidate list',
        )
        return candidates.shift()!
      },
    },
  })
  // On the old helper, force its port-0 IPv4 probe to choose the occupied
  // IPv6 port. This is a valid IPv4 listener, but the gateway cannot bind it.
  const listen = Server.prototype.listen
  t.mock.method(
    Server.prototype,
    'listen',
    function (this: Server, ...args: any[]) {
      if (args[0] === 0 && args[1] === '127.0.0.1') args[0] = occupiedPort
      return (listen as any).apply(this, args)
    },
  )
  const { unusedPort } = await import('./helpers/gateway-process.js')
  assert.equal(await unusedPort(), first)
  assert.equal(await unusedPort(), second)
  assert.deepEqual(candidates, [])
})
