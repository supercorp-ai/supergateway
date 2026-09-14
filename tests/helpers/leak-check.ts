import { afterEach } from 'node:test'
import { descendantsOf } from './process-tree.js'

/**
 * A process-accumulation check that every test gets for free.
 *
 * Registered as a side effect of importing the gateway harness, so every test
 * file that launches a gateway gets it and no runner flag is involved. An
 * earlier version used `--import`, which broke tsx's own registration on Node 18
 * and made every file fail with ERR_UNKNOWN_FILE_EXTENSION.
 *
 * `afterEach` here lands on the root context, so it runs after every test in the
 * process and — importantly — *before* that test's own `t.after` cleanup, so the
 * gateway is still alive and its descendants can still be counted.
 *
 * What it catches: children accumulating within one gateway's lifetime. That is
 * the shape of #108 (a child per POST, never reaped, until the container is
 * OOM-killed), #141 and #160.
 *
 * What it does not catch: a single child outliving a single session, which is
 * GW-015's own reproducer. The harness kills the gateway's whole process group
 * during cleanup, so one straggler is indistinguishable from normal teardown.
 * That case needs the targeted assertion those tests already make.
 *
 * The budget is per gateway, not per test, and deliberately loose: this is here
 * to catch unbounded growth, not to pin an exact count.
 */
const BUDGET = Number(process.env.SUPERGATEWAY_CHILD_BUDGET ?? 8)

const watched = new Map<number, string>()

export function watchGateway(pid: number | undefined, label: string) {
  if (pid) watched.set(pid, label)
}

export function forgetGateway(pid: number | undefined) {
  if (pid) watched.delete(pid)
}

afterEach(() => {
  const offenders: string[] = []
  for (const [pid, label] of watched) {
    const live = descendantsOf(pid)
    if (live.length > BUDGET)
      offenders.push(
        `${label} (pid ${pid}) has ${live.length} live descendants`,
      )
  }
  watched.clear()
  if (offenders.length)
    throw Error(
      `Processes accumulated beyond the budget of ${BUDGET}:\n  ${offenders.join('\n  ')}\n` +
        'Raise SUPERGATEWAY_CHILD_BUDGET only if the growth is genuinely expected.',
    )
})
