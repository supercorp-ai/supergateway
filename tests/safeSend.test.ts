import { test } from 'node:test'
import assert from 'node:assert/strict'
import { safeTransportSend } from '../src/lib/safeSend.js'

test('safeTransportSend handles sync throw', async () => {
  const errors: any[] = []
  const logger = {
    info: () => {},
    error: (...args: any[]) => errors.push(args),
  }

  safeTransportSend({
    transport: {
      send: () => {
        throw new Error('sync boom')
      },
    },
    message: { jsonrpc: '2.0' },
    logger,
    context: 'sync',
  })

  assert.ok(errors.length >= 1)
})

test('safeTransportSend handles async rejection without unhandledRejection', async () => {
  const errors: any[] = []
  const logger = {
    info: () => {},
    error: (...args: any[]) => errors.push(args),
  }

  const unhandled: any[] = []
  const onUnhandled = (reason: any) => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)
  try {
    safeTransportSend({
      transport: {
        send: () => Promise.reject(new Error('async boom')),
      },
      message: { jsonrpc: '2.0' },
      logger,
      context: 'async',
    })

    // Give the Promise rejection a chance to surface if it were unhandled.
    await new Promise((r) => setTimeout(r, 25))
  } finally {
    process.removeListener('unhandledRejection', onUnhandled)
  }

  assert.strictEqual(unhandled.length, 0)
  assert.ok(errors.length >= 1)
})
