import { test } from 'node:test'

/** Keep known regressions visible, but run them only when explicitly requested. */
export function knownBugTest(
  issue: string,
  name: string,
  options: { timeout: number },
  fn: NonNullable<Parameters<typeof test>[0]>,
) {
  const title = `${issue}: ${name}`
  if (process.env.RUN_KNOWN_BUG_TESTS === '1') {
    test(title, options, fn)
  } else {
    test.todo(title, options)
  }
}
