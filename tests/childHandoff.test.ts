import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import {
  ChildHandoff,
  ChildLink,
  processPeer,
  HANDOFF_WINDOW_MS,
  type ChildOwner,
} from '../src/lib/childHandoff.js'
import type { Logger } from '../src/types.js'

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  writes: string[] = []
  paused = false
  stdout = Object.assign(new EventEmitter(), {
    isPaused: () => this.paused,
    pause: () => {
      this.paused = true
    },
    resume: () => {
      this.paused = false
    },
  })
  stderr = new EventEmitter()
  stdin = Object.assign(new EventEmitter(), {
    write: (line: string) => {
      this.writes.push(line)
      return true
    },
  })
  say(...messages: unknown[]) {
    this.stdout.emit(
      'data',
      Buffer.from(messages.map((m) => JSON.stringify(m) + '\n').join('')),
    )
  }
}

const recordingOwner = () => {
  const events: unknown[][] = []
  let hold: Promise<void> | undefined
  const owner: ChildOwner = {
    message: (message, line) => events.push(['message', message, line]),
    nonJson: (line) => events.push(['nonJson', line]),
    stderr: (text) => events.push(['stderr', text]),
    failure: (kind, err) => events.push(['failure', kind, err.message]),
    exit: (code, signal) => events.push(['exit', code, signal]),
    output: () => hold,
  }
  return {
    owner,
    events,
    holdNext: (promise: Promise<void>) => (hold = promise),
  }
}

const logger = () => {
  const infos: string[] = []
  const errors: string[] = []
  return {
    infos,
    errors,
    logger: {
      info: (...args: unknown[]) => infos.push(args.map(String).join(' ')),
      error: (...args: unknown[]) => errors.push(args.map(String).join(' ')),
    } as unknown as Logger,
  }
}

const link = (owner: ChildOwner) => {
  const child = new FakeChild()
  let stops = 0
  const created = new ChildLink(
    processPeer(
      child as unknown as ChildProcessWithoutNullStreams,
      async () => {
        stops++
      },
    ),
    owner,
  )
  return { child, link: created, stops: () => stops }
}

const initialize = (
  id: number | string,
  params: Record<string, unknown> = {
    protocolVersion: '2025-06-18',
    // A null and an array, which comparing regardless of key order must leave
    // alone.
    capabilities: {
      roots: {},
      sampling: {},
      experimental: { tagged: { tags: ['b', 'a'], none: null } },
    },
    clientInfo: { name: 'pydantic-ai', version: '1' },
  },
): JSONRPCMessage => ({ jsonrpc: '2.0', id, method: 'initialize', params })

// A complete initialize that carries no id: a notification, not the handshake.
const { id: _unused, ...withoutId } = initialize(0) as { id: number }

test("a link delivers the child's output and endings to its owner", async () => {
  const { owner, events, holdNext } = recordingOwner()
  const { child, link: l } = link(owner)
  child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,'))
  child.stdout.emit('data', Buffer.from('"result":{}}\n \nnot json\n5\n'))
  assert.deepEqual(events, [
    [
      'message',
      { jsonrpc: '2.0', id: 1, result: {} },
      '{"jsonrpc":"2.0","id":1,"result":{}}',
    ],
    ['nonJson', 'not json'],
    // Valid JSON that is not an object is not a message either.
    ['nonJson', '5'],
  ])
  assert.equal(child.paused, false, 'nothing to wait for: keep reading')
  let release!: () => void
  holdNext(new Promise<void>((resolve) => (release = resolve)))
  child.say({ jsonrpc: '2.0', method: 'notifications/message' })
  assert.equal(child.paused, true, "the owner's client is behind: wait")
  release()
  await delay(0)
  assert.equal(child.paused, false)

  events.length = 0
  child.stderr.emit('data', Buffer.from('warming up'))
  child.emit('error', new Error('spawn failed'))
  child.stdin.emit('error', new Error('EPIPE'))
  child.emit('exit', 1, null)
  assert.deepEqual(events, [
    ['stderr', 'warming up'],
    ['failure', 'process', 'spawn failed'],
    ['failure', 'stdin', 'EPIPE'],
    ['exit', 1, null],
  ])
  l.write({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  assert.deepEqual(child.writes, [
    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n',
  ])
})

test('a link remembers the first initialize it was sent and whether it was answered', () => {
  const { owner } = recordingOwner()
  const { child, link: l } = link(owner)
  l.write(withoutId)
  assert.equal(l.initialize, undefined, 'one without an id is no handshake')
  l.write(initialize(0))
  l.write(initialize(9))
  assert.equal(l.initialize?.id, 0, 'only the first counts')

  child.say({ jsonrpc: '2.0', id: 1, result: {} })
  child.say({ jsonrpc: '2.0', id: 0, method: 'ping' })
  child.say({ jsonrpc: '2.0', method: 'notifications/message' })
  child.say({ jsonrpc: '2.0', result: {} })
  assert.equal(
    l.answered,
    false,
    'another reply, a request, a notification, a reply with no id',
  )
  child.say({ jsonrpc: '2.0', id: 0, result: {} })
  assert.equal(l.answered, true)
})

test('a child is stopped, not kept, unless its client left during initialize', () => {
  const { logger: log, infos } = logger()
  const handoff = new ChildHandoff(log, 1000)
  const cases: [string, (l: ChildLink, child: FakeChild) => boolean][] = [
    [
      'client sent more than initialize',
      (l) => (l.write(initialize(0)), false),
    ],
    ['child never got an initialize', () => true],
    [
      'child answered it',
      (l, child) => (
        l.write(initialize(0)),
        child.say({ jsonrpc: '2.0', id: 0, result: {} }),
        true
      ),
    ],
    [
      'child exited',
      (l, child) => (l.write(initialize(0)), (child.exitCode = 0), true),
    ],
    [
      'child was killed',
      (l, child) => (
        l.write(initialize(0)),
        (child.signalCode = 'SIGTERM'),
        true
      ),
    ],
  ]
  for (const [name, arrange] of cases) {
    const { owner } = recordingOwner()
    const made = link(owner)
    const onlyInitialize = arrange(made.link, made.child)
    handoff.release(made.link, onlyInitialize, 'Session s')
    assert.equal(made.stops(), 1, name)
  }
  assert.equal(
    infos.filter((line) => /keeping the server/.test(line)).length,
    0,
  )
})

test('an abandoned child is handed to the next identical initialize, with its answer', async () => {
  const { logger: log, infos } = logger()
  const handoff = new ChildHandoff(log, 1000)
  const first = link(recordingOwner().owner)
  first.link.write(initialize(0))
  handoff.release(first.link, true, 'Session a')
  assert.equal(first.stops(), 0, 'kept for a retry')
  assert.match(
    infos.join('\n'),
    /Session a: client left before its initialize was answered; keeping the server 1000 ms/,
  )

  // What it says while nobody is attached waits for the next client.
  first.child.say({
    jsonrpc: '2.0',
    method: 'notifications/message',
    params: { data: 'up' },
  })
  first.child.stdout.emit('data', Buffer.from('garbage\n'))
  first.child.stderr.emit('data', Buffer.from('ready'))

  const next = recordingOwner()
  const other = recordingOwner()
  assert.equal(
    handoff.adopt(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      next.owner,
      'B',
    ),
    undefined,
    'only an initialize can take a child over',
  )
  assert.equal(handoff.adopt(withoutId, next.owner, 'B'), undefined)
  assert.equal(
    handoff.adopt(
      initialize(5, {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'pydantic-ai', version: '1' },
      }),
      other.owner,
      'C',
    ),
    undefined,
    'a different initialize is a different client',
  )

  // The same params in another key order are the same initialize.
  const adopted = handoff.adopt(
    initialize('b-1', {
      clientInfo: { version: '1', name: 'pydantic-ai' },
      capabilities: {
        experimental: { tagged: { none: null, tags: ['b', 'a'] } },
        sampling: {},
        roots: {},
      },
      protocolVersion: '2025-06-18',
    }),
    next.owner,
    'Session b',
  )
  assert.equal(adopted, first.link)
  assert.match(infos.join('\n'), /Session b: took over a server/)
  assert.deepEqual(next.events, [
    [
      'message',
      {
        jsonrpc: '2.0',
        method: 'notifications/message',
        params: { data: 'up' },
      },
      '{"jsonrpc":"2.0","method":"notifications/message","params":{"data":"up"}}',
    ],
  ])

  // A request from the server that reuses the id, a reply with no id and a
  // reply to something else are not the answer, and pass unchanged.
  first.child.say({ jsonrpc: '2.0', id: 0, method: 'ping' })
  first.child.say({ jsonrpc: '2.0', result: {} })
  first.child.say({ jsonrpc: '2.0', id: 99, result: {} })
  assert.deepEqual(
    next.events.slice(1).map(([, message]) => message),
    [
      { jsonrpc: '2.0', id: 0, method: 'ping' },
      { jsonrpc: '2.0', result: {} },
      { jsonrpc: '2.0', id: 99, result: {} },
    ],
  )
  next.events.splice(1)

  // The answer to the original initialize arrives as the new client's own.
  first.child.say({ jsonrpc: '2.0', id: 0, result: { serverInfo: {} } })
  first.child.say({ jsonrpc: '2.0', id: 0, result: { again: true } })
  first.child.say({ jsonrpc: '2.0', id: 7, result: {} })
  assert.deepEqual(next.events.slice(1), [
    [
      'message',
      { jsonrpc: '2.0', id: 'b-1', result: { serverInfo: {} } },
      '{"jsonrpc":"2.0","id":"b-1","result":{"serverInfo":{}}}',
    ],
    [
      'message',
      { jsonrpc: '2.0', id: 0, result: { again: true } },
      '{"jsonrpc":"2.0","id":0,"result":{"again":true}}',
    ],
    [
      'message',
      { jsonrpc: '2.0', id: 7, result: {} },
      '{"jsonrpc":"2.0","id":7,"result":{}}',
    ],
  ])
  first.child.emit('exit', 0, null)
  assert.deepEqual(
    next.events.at(-1),
    ['exit', 0, null],
    "its endings are the new owner's now",
  )
  assert.equal(
    handoff.adopt(initialize(9), other.owner, 'D'),
    undefined,
    'taken once',
  )
})

test('an answer that came while waiting is replayed to the new client under its id', () => {
  const { logger: log } = logger()
  const handoff = new ChildHandoff(log, 1000)
  const first = link(recordingOwner().owner)
  first.link.write(initialize(0))
  handoff.release(first.link, true, 'A')
  first.child.say({ jsonrpc: '2.0', id: 0, result: {} })
  const next = recordingOwner()
  handoff.adopt(initialize(42), next.owner, 'B')
  assert.deepEqual(next.events, [
    [
      'message',
      { jsonrpc: '2.0', id: 42, result: {} },
      '{"jsonrpc":"2.0","id":42,"result":{}}',
    ],
  ])
})

test('several waiting children for one initialize are taken oldest first', () => {
  const { logger: log } = logger()
  const handoff = new ChildHandoff(log, 1000)
  const a = link(recordingOwner().owner)
  const b = link(recordingOwner().owner)
  for (const made of [a, b]) {
    made.link.write(initialize(0))
    handoff.release(made.link, true, 'X')
  }
  assert.equal(
    handoff.adopt(initialize(1), recordingOwner().owner, 'Y'),
    a.link,
  )
  assert.equal(
    handoff.adopt(initialize(2), recordingOwner().owner, 'Z'),
    b.link,
  )
  assert.equal(
    handoff.adopt(initialize(3), recordingOwner().owner, 'W'),
    undefined,
  )
})

test('a waiting child nobody takes is stopped once, however it ends', async () => {
  const { logger: log, infos, errors } = logger()
  const handoff = new ChildHandoff(log, 20)

  const expired = link(recordingOwner().owner)
  expired.link.write(initialize(0))
  handoff.release(expired.link, true, 'Session e')
  await delay(60)
  assert.equal(expired.stops(), 1)
  // Stopping it makes it exit, which is not a second ending.
  expired.child.emit('exit', null, 'SIGTERM')
  assert.equal(expired.stops(), 1)
  assert.equal(
    handoff.adopt(initialize(1), recordingOwner().owner, 'B'),
    undefined,
  )

  const exited = link(recordingOwner().owner)
  exited.link.write(initialize(0))
  handoff.release(exited.link, true, 'Session x')
  exited.child.emit('exit', 3, null)
  const failed = link(recordingOwner().owner)
  failed.link.write(initialize(0))
  handoff.release(failed.link, true, 'Session f')
  failed.child.stdin.emit('error', new Error('EPIPE'))
  assert.deepEqual([exited.stops(), failed.stops()], [1, 1])
  assert.equal(
    handoff.adopt(initialize(1), recordingOwner().owner, 'B'),
    undefined,
  )
  assert.deepEqual(
    infos.filter((line) => /stopping the waiting server/.test(line)),
    [
      'Session e: stopping the waiting server: no client took it over',
      'Session x: stopping the waiting server: it exited, code=3, signal=null',
      'Session f: stopping the waiting server: stdin failure: EPIPE',
    ],
  )
  assert.deepEqual(errors, [])
})

test('a waiting child is not read again until it is taken over or stopped', async () => {
  const { logger: log } = logger()
  const handoff = new ChildHandoff(log, 1000)
  const taken = link(recordingOwner().owner)
  taken.link.write(initialize(0))
  handoff.release(taken.link, true, 'A')
  assert.equal(taken.child.paused, false, 'nothing read yet, nothing held')
  taken.child.say({ jsonrpc: '2.0', method: 'notifications/message' })
  assert.equal(taken.child.paused, true, 'the rest waits in its pipe')
  handoff.adopt(initialize(1), recordingOwner().owner, 'B')
  await delay(0)
  assert.equal(taken.child.paused, false, 'its new client reads it')

  const stopped = link(recordingOwner().owner)
  stopped.link.write(initialize(0))
  handoff.release(stopped.link, true, 'C')
  stopped.child.say({ jsonrpc: '2.0', method: 'notifications/message' })
  stopped.child.emit('exit', 0, null)
  await delay(0)
  assert.equal(stopped.child.paused, false, 'a stopped one is drained')
})

test("a waiting child's stderr and stray output are logged", () => {
  const { logger: log, errors } = logger()
  const handoff = new ChildHandoff(log, 1000)
  const made = link(recordingOwner().owner)
  made.link.write(initialize(0))
  handoff.release(made.link, true, 'Session w')
  made.child.stderr.emit('data', Buffer.from('booting'))
  made.child.stdout.emit('data', Buffer.from('banner\n'))
  assert.deepEqual(errors, [
    'Session w: waiting server stderr: booting',
    'Session w: waiting server wrote non-JSON: banner',
  ])
})

test('a discarded child is stopped and nothing it does reaches a session', () => {
  const { logger: log, infos } = logger()
  const handoff = new ChildHandoff(log, 1000)
  const { owner, events } = recordingOwner()
  const made = link(owner)
  handoff.discard(made.link, 'Session d')
  assert.equal(made.stops(), 1)
  made.child.say({ jsonrpc: '2.0', method: 'notifications/message' })
  made.child.stdout.emit('data', Buffer.from('x\n'))
  made.child.stderr.emit('data', Buffer.from('bye'))
  made.child.emit('error', new Error('late'))
  made.child.emit('exit', null, 'SIGTERM')
  assert.deepEqual(events, [])
  assert.equal(made.link.owner.output(), undefined)
  assert.deepEqual(infos, [
    'Session d: unused server stopped, code=null, signal=SIGTERM',
  ])
})

test('the window is long enough for a client retry and is not a flag', () => {
  assert.equal(HANDOFF_WINDOW_MS, 30000)
  assert.equal(new ChildHandoff(logger().logger)['windowMs'], HANDOFF_WINDOW_MS)
})
