/**
 * What this build means to do differently from a released version, as
 * `crossVersion.test.ts` observes it: both sides, and why.
 *
 * By version, then by the group the test compares, then by what was
 * observed. An entry that no longer differs fails the test, so this stays
 * the list of what a client of that version would notice.
 */
export interface Intended {
  /** What the released version answered. */
  was: unknown
  /** What this build answers. */
  now: unknown
  /** The pull request, and the reason in a sentence. */
  why: string
}

// A server's own error code reached a bridge's client rewritten as an HTTP
// failure from 4.0.0 on. It arrives as the server sent it again.
const applicationError: Record<string, Intended> = {
  'tools/list': {
    was: {
      error: {
        code: -32000,
        message: 'MCP error -32000: HTTP 42: MCP error 42: quota exceeded',
        data: { retryAfter: 5 },
      },
    },
    now: {
      error: {
        code: 42,
        message: 'MCP error 42: quota exceeded',
        data: { retryAfter: 5 },
      },
    },
    why: '#273 (GW-036): a bridge passes an application error through with its own code, as 3.4.3 did.',
  },
}

export const intended: Record<
  string,
  Record<string, Record<string, Intended>>
> = {
  '4.1.0': {
    'command line': {
      'sse: an option that does not exist, in the log': {
        was: [],
        now: ['[supergateway] Ignored unknown option --keepAlive (see --help)'],
        why: '#284: an option the gateway does not have is said to be ignored instead of dropped in silence. The gateway starts as before.',
      },
    },
    'application error through --sse': applicationError,
    'application error through --streamableHttp': applicationError,
  },
}
