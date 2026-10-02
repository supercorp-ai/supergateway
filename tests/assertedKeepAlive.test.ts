import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { keepConnectionsAlive } from '../src/lib/keepConnectionsAlive.js'

// The header timeout every listening gateway's server gets alongside its
// 65-second keep-alive. keepAlive.test.ts shows the keep-alive end to end;
// the header timeout only shows on a client whose headers take over a
// minute to arrive, too slow to run, so its contract is checked here: it
// must outlast the keep-alive, or Node's 60-second default would cut off a
// connection the keep-alive promised to hold.

test('the header timeout outlasts the keep-alive', () => {
  const server = keepConnectionsAlive(http.createServer())
  // map: the keep-alive outlasts a load balancer's 60 seconds
  assert.equal(server.keepAliveTimeout, 65_000)
  // map: and the header timeout outlasts the keep-alive
  assert.ok(
    server.headersTimeout > server.keepAliveTimeout,
    `headersTimeout ${server.headersTimeout} <= keepAliveTimeout ${server.keepAliveTimeout}`,
  )
})
