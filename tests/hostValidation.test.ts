import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  acceptedHosts,
  hostName,
  validateHost,
  verifyWsHost,
} from '../src/lib/hostValidation.js'

const fakeRes = () => {
  const res: any = {
    status: undefined,
    json: undefined,
    statusCode: 0,
    body: undefined,
  }
  res.status = (code: number) => {
    res.statusCode = code
    return res
  }
  res.json = (body: unknown) => {
    res.body = body
    return res
  }
  return res
}

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as any

const middleware = validateHost(
  acceptedHosts('127.0.0.1', ['mypc.local']),
  logger,
)
const runs = (host: string | undefined) => {
  let next = false
  middleware(
    { headers: host === undefined ? {} : { host } } as any,
    fakeRes(),
    () => {
      next = true
    },
  )
  return next
}

test('loopback names pass', () => {
  for (const host of [
    'localhost',
    'localhost:8000',
    '127.0.0.1',
    '127.0.0.1:8000',
    '[::1]',
    '[::1]:8000',
    '::1',
  ])
    assert.equal(runs(host), true, host)
})

test('a rebound domain is refused', () => {
  for (const host of [
    'evil.example.com',
    'evil.example.com:8000',
    'attacker.net',
    'LOCALHOST.EVIL.COM',
  ])
    assert.equal(runs(host), false, host)
})

test('a missing Host header is refused', () => {
  assert.equal(runs(undefined), false)
})

test('--allow-host adds a name', () => {
  assert.equal(runs('mypc.local'), true)
})

test('the machine owns the Host a browser sends it', () => {
  const accepted = acceptedHosts(undefined, [])
  const addresses = accepted.filter((name) => /^\d+\.\d+\.\d+\.\d+$/.test(name))
  assert.ok(addresses.length > 0, 'the machine has at least one IPv4 address')
})

test('hostName strips the port, brackets kept', () => {
  assert.equal(hostName('localhost:8000'), 'localhost')
  assert.equal(hostName('[::1]:8000'), '[::1]')
  assert.equal(hostName('[::1]'), '[::1]')
  assert.equal(hostName('127.0.0.1'), '127.0.0.1')
})

test('verifyWsHost rejects before the key check', () => {
  const accepted = acceptedHosts('127.0.0.1', [])
  const verify = verifyWsHost(accepted, logger)
  let ok = true
  verify(
    { req: { headers: { host: 'evil.example.com' } } } as any,
    (allowed: boolean) => {
      ok = allowed
    },
  )
  assert.equal(ok, false)
  verify(
    { req: { headers: { host: 'localhost:8000' } } } as any,
    (allowed: boolean) => {
      ok = allowed
    },
  )
  assert.equal(ok, true)
})
