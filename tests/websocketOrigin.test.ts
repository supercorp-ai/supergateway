import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import type { CorsOptions } from 'cors'
import { verifyWebSocket } from '../src/lib/websocketOrigin.js'

// The check on a WebSocket upgrade, decision by decision: the API key as
// before, then `--cors`, and what is logged.

const KEY = 'k1'

const check = (corsOrigin: CorsOptions['origin'], apiKeys: string[] = []) => {
  const lines: string[] = []
  const logger = {
    info: (line: string) => lines.push(line),
    error: (line: string) => lines.push(`error: ${line}`),
  }
  const verify = verifyWebSocket(corsOrigin, apiKeys, logger)
  const upgrade = (headers: Record<string, string>) =>
    new Promise<{ accepted: boolean; status?: number; body?: string }>(
      (resolve) =>
        verify(
          {
            origin: headers.origin,
            secure: false,
            req: {
              method: 'GET',
              url: '/message',
              headers,
            } as unknown as IncomingMessage,
          },
          (accepted, status, body) => resolve({ accepted, status, body }),
        ),
    )
  return { upgrade, lines }
}

const keyed = { authorization: `Bearer ${KEY}` }
const forbidden = {
  accepted: false,
  status: 403,
  body: '{"jsonrpc":"2.0","error":{"code":-32001,"message":"Forbidden: origin not allowed"},"id":null}',
}

test('without --cors or a key, every upgrade is accepted, and each web page origin logged once', async () => {
  const { upgrade, lines } = check(false)
  assert.deepEqual(await upgrade({}), {
    accepted: true,
    status: undefined,
    body: undefined,
  })
  assert.deepEqual(lines, [])
  for (const origin of ['https://a.test', 'https://a.test', 'null'])
    assert.equal((await upgrade({ origin })).accepted, true)
  assert.deepEqual(lines, [
    'A web page at https://a.test connected over WebSocket. --cors limits which origins can.',
    'A web page at null connected over WebSocket. --cors limits which origins can.',
  ])
})

test('without --cors but with a key, the key decides and nothing is logged', async () => {
  const { upgrade, lines } = check(false, [KEY])
  assert.equal(
    (await upgrade({ origin: 'https://a.test', ...keyed })).accepted,
    true,
  )
  const refused = await upgrade({ origin: 'https://a.test' })
  assert.equal(refused.accepted, false)
  assert.equal(refused.status, 401)
  assert.deepEqual(lines, [
    'Rejected a request without a valid API key: GET /message',
  ])
})

test('bare --cors accepts every origin, and logs none', async () => {
  const { upgrade, lines } = check('*')
  assert.equal((await upgrade({ origin: 'https://a.test' })).accepted, true)
  assert.equal((await upgrade({})).accepted, true)
  assert.deepEqual(lines, [])
})

test('--cors with origins: a listed or matching origin, or none, is accepted; any other is refused', async () => {
  const { upgrade, lines } = check([
    'https://app.test',
    /^https:\/\/[a-z]+\.team\.test$/,
  ])
  assert.equal((await upgrade({ origin: 'https://app.test' })).accepted, true)
  assert.equal(
    (await upgrade({ origin: 'https://blue.team.test' })).accepted,
    true,
  )
  // Not a browser: no Origin at all.
  assert.equal((await upgrade({})).accepted, true)
  assert.deepEqual(lines, [])
  for (const origin of [
    'https://evil.test',
    'http://app.test',
    'https://app.test.evil.test',
    'null',
  ])
    assert.deepEqual(await upgrade({ origin }), forbidden, origin)
  assert.deepEqual(lines, [
    'Refused a WebSocket connection from https://evil.test: not in --cors',
    'Refused a WebSocket connection from http://app.test: not in --cors',
    'Refused a WebSocket connection from https://app.test.evil.test: not in --cors',
    'Refused a WebSocket connection from null: not in --cors',
  ])
})

test('--cors with origins and a key: the key first, as before, then the origin', async () => {
  const { upgrade } = check(['https://app.test'], [KEY])
  // Without the key it is the 401 it always was, whatever the origin.
  assert.equal((await upgrade({ origin: 'https://evil.test' })).status, 401)
  assert.deepEqual(
    await upgrade({ origin: 'https://evil.test', ...keyed }),
    forbidden,
  )
  assert.equal(
    (await upgrade({ origin: 'https://app.test', ...keyed })).accepted,
    true,
  )
})
