import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { ChildOwner, Peer, StartPeer } from '../../src/lib/childHandoff.js'

// An MCP server in memory, as a peer: it answers the way its spec says, a
// tick later, and the test can make it say anything else, fail, or exit.

type Message = Record<string, any>

export interface FakeServerSpec {
  /** The versions it speaks; it answers the client's if it is one, else the last. */
  versions?: string[]
  capabilities?: Record<string, unknown>
  instructions?: string
  tools?: string[]
  /** Pages of tool names, in place of `tools`: a cursor between each. */
  toolPages?: string[][]
  prompts?: string[]
  resources?: string[]
  templates?: string[]
  /** Answers that replace the default, by method. */
  answers?: Record<string, (request: Message) => Message | undefined | 'hold'>
}

export function fakeServer(name: string, spec: FakeServerSpec = {}) {
  const versions = spec.versions ?? ['2025-06-18']
  const instances: {
    owner: ChildOwner
    received: Message[]
    ended: boolean
    stopped: boolean
    gone: boolean
  }[] = []
  const item = (key: string) => (id: string) => ({ [key]: id })
  const defaults: Record<string, (request: Message) => Message> = {
    initialize: ({ params }) => ({
      protocolVersion: versions.includes(params?.protocolVersion)
        ? params.protocolVersion
        : versions.at(-1),
      capabilities: spec.capabilities ?? {
        ...(spec.tools || spec.toolPages ? { tools: {} } : {}),
        ...(spec.prompts ? { prompts: {} } : {}),
        ...(spec.resources || spec.templates ? { resources: {} } : {}),
      },
      serverInfo: { name, version: '1' },
      ...(spec.instructions ? { instructions: spec.instructions } : {}),
    }),
    ping: () => ({}),
    'tools/list': ({ params }) => {
      if (!spec.toolPages)
        return { tools: (spec.tools ?? []).map(item('name')) }
      const page = params?.cursor ? Number(params.cursor) : 0
      return {
        tools: spec.toolPages[page].map(item('name')),
        ...(page + 1 < spec.toolPages.length
          ? { nextCursor: String(page + 1) }
          : {}),
      }
    },
    'prompts/list': () => ({ prompts: (spec.prompts ?? []).map(item('name')) }),
    'resources/list': () => ({
      resources: (spec.resources ?? []).map(item('uri')),
    }),
    'resources/templates/list': () => ({
      resourceTemplates: (spec.templates ?? []).map(item('uriTemplate')),
    }),
    'tools/call': ({ params }) => ({
      content: [{ type: 'text', text: `${name} ran ${params.name}` }],
    }),
    'prompts/get': ({ params }) => ({ description: `${name}: ${params.name}` }),
    'resources/read': ({ params }) => ({
      contents: [{ uri: params.uri, text: name }],
    }),
    'resources/subscribe': () => ({}),
    'resources/unsubscribe': () => ({}),
    'completion/complete': () => ({ completion: { values: [name] } }),
    'logging/setLevel': () => ({}),
  }

  const start = (): StartPeer => (owner) => {
    const instance = {
      owner,
      received: [] as Message[],
      ended: false,
      stopped: false,
      gone: false,
    }
    instances.push(instance)
    const peer: Peer = {
      write: (message: JSONRPCMessage) => {
        const request = message as Message
        instance.received.push(request)
        if (!('method' in request) || !('id' in request)) return
        queueMicrotask(() => {
          if (instance.gone) return
          const custom = spec.answers?.[request.method]?.(request)
          if (custom === 'hold') return
          const answer =
            custom ??
            (defaults[request.method]
              ? { result: defaults[request.method](request) }
              : { error: { code: -32601, message: 'Method not found' } })
          const reply = { jsonrpc: '2.0', id: request.id, ...answer }
          owner.message(reply, JSON.stringify(reply))
        })
      },
      end: () => {
        instance.ended = true
      },
      stop: async () => {
        instance.stopped = true
        instance.gone = true
      },
      get gone() {
        return instance.gone
      },
    }
    return peer
  }

  const last = () => instances.at(-1)!
  return {
    name,
    start,
    instances,
    /** What the latest instance was sent, as methods (or "response"). */
    methods: () =>
      last().received.map((message) => message.method ?? 'response'),
    received: () => last().received,
    /** The latest instance says `message` to its owner. */
    say: (message: Message) =>
      last().owner.message(message, JSON.stringify(message)),
    exit: (code: number | null = 1, signal: NodeJS.Signals | null = null) => {
      last().gone = true
      last().owner.exit(code, signal)
    },
    fail: (kind: 'process' | 'stdin' | 'upstream', message: string) => {
      last().gone = true
      last().owner.failure(kind, Error(message))
    },
  }
}

/** The client's side of a peer: what it was told, and a way to ask. */
export function fakeClient(start: StartPeer) {
  const told: Message[] = []
  const lines: string[] = []
  const exits: [number | null, NodeJS.Signals | null][] = []
  const other: [string, string][] = []
  const waiting = new Map<unknown, (message: Message) => void>()
  let ids = 0
  const peer = start({
    message: (message, line) => {
      told.push(message)
      lines.push(line)
      const answered = 'method' in message ? undefined : waiting.get(message.id)
      if (answered) {
        waiting.delete(message.id)
        answered(message)
      }
    },
    nonJson: (line) => other.push(['nonJson', line]),
    stderr: (text) => other.push(['stderr', text]),
    failure: (kind, err) => other.push(['failure', `${kind}: ${err.message}`]),
    exit: (code, signal) => exits.push([code, signal]),
    output: () => undefined,
  })
  const request = (
    method: string,
    params?: Message,
    id: string | number = ++ids,
  ) =>
    new Promise<Message>((resolve) => {
      waiting.set(id, resolve)
      peer.write({ jsonrpc: '2.0', id, method, params } as JSONRPCMessage)
    })
  return {
    peer,
    told,
    lines,
    exits,
    other,
    request,
    notify: (method: string, params?: Message) =>
      peer.write({ jsonrpc: '2.0', method, params } as JSONRPCMessage),
    initialize: (protocolVersion = '2025-06-18') =>
      request('initialize', {
        protocolVersion,
        capabilities: { sampling: {} },
        clientInfo: { name: 'test', version: '1' },
      }),
    /** Everything said so far that is not an answer to a request. */
    unasked: () => told.filter((message) => 'method' in message),
  }
}

/** Lets everything already queued run. */
export const settled = () => new Promise((resolve) => setImmediate(resolve))
