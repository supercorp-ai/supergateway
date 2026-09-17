import { test } from 'node:test'
import assert from 'node:assert/strict'
import { launchGateway } from './helpers/gateway-process.js'

/**
 * What a readiness failure has to tell us.
 *
 * The 2026-09-17 soak lost all twelve matrix jobs to one Windows gateway that
 * never became ready, and the only evidence it left was
 * `Gateway did not become ready:\n\n` — two empty interpolations. That message
 * cannot distinguish a gateway that never started from one that started and
 * hung, nor a stuck gateway from a runner too starved to schedule either
 * process. Every assertion here exists so the next occurrence arrives with that
 * distinction already made.
 */

const budget = async <T>(ms: number, run: () => Promise<T>) => {
  const previous = process.env.SUPERGATEWAY_TEST_READY_TIMEOUT
  process.env.SUPERGATEWAY_TEST_READY_TIMEOUT = String(ms)
  try {
    return await run()
  } finally {
    if (previous === undefined)
      delete process.env.SUPERGATEWAY_TEST_READY_TIMEOUT
    else process.env.SUPERGATEWAY_TEST_READY_TIMEOUT = previous
  }
}

const readyFailure = async (
  t: Parameters<typeof launchGateway>[0],
  nodeArgs: string[],
) =>
  budget(600, async () => {
    const gateway = launchGateway(t, [], undefined, nodeArgs)
    const error = await gateway.ready().then(
      () => null,
      (reason: Error) => reason,
    )
    assert.ok(error, 'expected the gateway to fail readiness')
    return error.message
  })

test('a gateway that starts but never logs is reported as running and silent', async (t) => {
  const message = await readyFailure(t, ['-e', 'setTimeout(() => {}, 60000)'])
  assert.match(message, /still running/)
  assert.match(message, /wrote nothing/)
  // The soak's failure looked exactly like this and said none of it.
  assert.doesNotMatch(message, /exited with code/)
})

test('a readiness failure reports how often it managed to poll', async (t) => {
  const message = await readyFailure(t, ['-e', 'setTimeout(() => {}, 60000)'])
  const polls = Number(/over (\d+) polls/.exec(message)?.[1])
  const waited = Number(/waited (\d+)ms/.exec(message)?.[1])
  assert.ok(Number.isFinite(polls) && Number.isFinite(waited))
  // Each pass asks for 10ms, so an unstarved host lands near waited/10. This
  // only has to separate "scheduled normally" from "barely scheduled at all":
  // a runner stall shows up as a poll count far below its elapsed time.
  assert.ok(
    polls > waited / 40,
    `expected healthy scheduling, got ${polls} polls across ${waited}ms`,
  )
})

test('a gateway that exits before readiness reports its exit code and output', async (t) => {
  const message = await readyFailure(t, [
    '-e',
    'console.log("Starting..."); process.exit(3)',
  ])
  assert.match(message, /exited with code 3/)
  assert.match(message, /wrote \d+ chars, first \d+ms after spawn/)
  assert.match(message, /Starting\.\.\./)
})

test('a gateway that cannot spawn is reported instead of crashing the test file', async (t) => {
  const previous = process.env.SUPERGATEWAY_TEST_NODE
  process.env.SUPERGATEWAY_TEST_NODE = 'supergateway-no-such-binary'
  try {
    const message = await readyFailure(t, [])
    assert.match(message, /spawn failed/)
    assert.match(message, /pid unassigned/)
  } finally {
    if (previous === undefined) delete process.env.SUPERGATEWAY_TEST_NODE
    else process.env.SUPERGATEWAY_TEST_NODE = previous
  }
})

test('a failed spawn is reported promptly rather than after the full budget', async (t) => {
  const previous = process.env.SUPERGATEWAY_TEST_NODE
  process.env.SUPERGATEWAY_TEST_NODE = 'supergateway-no-such-binary'
  const startedAt = Date.now()
  try {
    await readyFailure(t, [])
  } finally {
    if (previous === undefined) delete process.env.SUPERGATEWAY_TEST_NODE
    else process.env.SUPERGATEWAY_TEST_NODE = previous
  }
  // The spawn error is known immediately; waiting out the budget for it just
  // spends soak time to learn nothing.
  assert.ok(
    Date.now() - startedAt < 500,
    'a spawn failure should not wait for the readiness budget',
  )
})
