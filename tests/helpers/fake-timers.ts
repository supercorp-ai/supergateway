import type { TestContext } from 'node:test'

/**
 * Enable the runner's fake timers across Node versions.
 *
 * Node 20.4 changed the signature: `enable(['setTimeout'])` became
 * `enable({ apis: ['setTimeout'] })`. Node 18 still rejects the object form with
 * `ERR_INVALID_ARG_TYPE` from inside MockTimers.enable, before a test reaches
 * any gateway code, so calling it directly makes those suites unrunnable there
 * for a reason that has nothing to do with what they check.
 */
export function enableFakeTimers(
  t: TestContext,
  apis: string[] = ['setTimeout'],
) {
  const timers = t.mock.timers as unknown as {
    enable: (options: unknown) => void
  }
  try {
    timers.enable({ apis })
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ERR_INVALID_ARG_TYPE')
      throw error
    timers.enable(apis)
  }
}
