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

const listenerWarnings: Record<string, Intended> = {
  'unauthenticated listener warnings': {
    was: { sse: 0, ws: 0, stateless: 0, stateful: 0 },
    now: { sse: 1, ws: 1, stateless: 1, stateful: 1 },
    why: '#360: a non-loopback listener serving MCP without an API key now warns once on stderr.',
  },
}

const browserWarnings: Record<string, Intended> = {
  'WebSocket warnings for web pages': {
    was: { sse: 0, ws: 0, stateless: 0, stateful: 0 },
    now: { sse: 0, ws: 1, stateless: 0, stateful: 0 },
    why: 'A WebSocket server with neither --cors nor an API key, which any web page can use, now warns once on stderr.',
  },
}

// A fresh install gives the MCP SDK @hono/node-server 2.x since 4.2.3, which
// sends an empty answer without a Content-Type. 4.2.3 as published already
// does; until then the lockfile kept 1.19, which sent text/plain.
const plain = 'text/plain; charset=UTF-8'
const stateful = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'Mcp-Session-Id',
  'x-team': 'core',
}
const emptyAnswer = (status: number, headers: Record<string, string>) => ({
  was: {
    status,
    headers: { 'content-type': plain, ...headers },
    sessionHeader: 'absent',
    body: '',
  },
  now: { status, headers, sessionHeader: 'absent', body: '' },
  why: '@hono/node-server 2.x, which a fresh install of 4.2.3 already has: an answer with no body has no Content-Type.',
})
const emptyAnswers: Record<string, Intended> = {
  'stateless: a notification': emptyAnswer(202, {
    'access-control-allow-origin': '*',
    'x-team': 'core',
  }),
  'stateful: initialized': emptyAnswer(202, stateful),
  'stateful: DELETE the session': emptyAnswer(200, stateful),
}

export const intended: Record<
  string,
  Record<string, Record<string, Intended>>
> = {
  '4.1.0': {
    'command line': {
      ...listenerWarnings,
      ...browserWarnings,
      'sse: an option that does not exist, in the log': {
        was: [],
        now: ['[supergateway] Ignored unknown option --keepAlive (see --help)'],
        why: '#284: an option the gateway does not have is said to be ignored instead of dropped in silence. The gateway starts as before.',
      },
    },
    'application error through --sse': applicationError,
    'application error through --streamableHttp': applicationError,
    'HTTP answers': emptyAnswers,
  },
  '4.2.0': {
    'command line': { ...listenerWarnings, ...browserWarnings },
    'HTTP answers': emptyAnswers,
  },
  '4.2.1': {
    'command line': { ...listenerWarnings, ...browserWarnings },
    'HTTP answers': emptyAnswers,
  },
  '4.2.2': { 'command line': browserWarnings, 'HTTP answers': emptyAnswers },
}
