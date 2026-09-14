import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Version of the `@modelcontextprotocol/sdk` actually installed. */
export function sdkVersion(): string {
  const require = createRequire(import.meta.url)
  let dir = dirname(require.resolve('@modelcontextprotocol/sdk/types.js'))
  for (let depth = 0; depth < 8; depth++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      if (pkg.name === '@modelcontextprotocol/sdk') return pkg.version as string
    } catch {
      // Keep walking: the SDK's exports map sends "./package.json" into
      // dist/esm, whose package.json carries only `type`.
    }
    dir = dirname(dir)
  }
  throw Error(
    'Could not determine the installed @modelcontextprotocol/sdk version',
  )
}

const ordinal = (version: string) =>
  version
    .split('-')[0]
    .split('.')
    .map(Number)
    .reduce((acc, part) => acc * 10000 + part, 0)

/** Whether the installed SDK is in `[from, before)`. */
export function sdkBetween(from: string, before: string): boolean {
  const v = ordinal(sdkVersion())
  return v >= ordinal(from) && v < ordinal(before)
}

/**
 * A test that a defect *in a dependency* is known to fail on some versions.
 *
 * Only for upstream defects. A test that fails because this gateway is wrong
 * belongs in `knownBugTest`, or better, gets fixed — hiding our own bug behind a
 * version check is how a suite stops meaning anything.
 *
 * Unlike a skip or a TODO, the expectation is enforced in both directions: on an
 * affected version the test must still fail, and if it starts passing this fails
 * loudly instead of quietly staying marked. That is what keeps the marker honest
 * when the dependency is fixed, the range moves, or the bug turns out to be ours
 * after all.
 */
export function expectedUpstreamFailure(
  affected: boolean,
  reason: string,
  name: string,
  options: { timeout: number },
  fn: NonNullable<Parameters<typeof test>[0]>,
) {
  if (!affected) return test(name, options, fn)
  return test(`${name} [upstream: ${reason}]`, options, async (t) => {
    let failure: unknown
    try {
      await (fn as (c: unknown) => unknown)(t)
    } catch (error) {
      failure = error
    }
    assert.ok(
      failure !== undefined,
      `Marked as an expected upstream failure (${reason}) on SDK ${sdkVersion()}, but it passed. ` +
        'The dependency is fixed, the affected range is wrong, or the fault was never upstream — remove or narrow the marker.',
    )
  })
}
