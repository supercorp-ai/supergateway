import type { ChildProcessWithoutNullStreams } from 'child_process'
import { StringDecoder } from 'node:string_decoder'
import {
  JSONRPCMessage,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js'
import { Logger } from '../types.js'
import { LineSplitter } from './lineSplitter.js'
import { holdOutput } from './outputBackpressure.js'

// How long a child whose client gave up during initialize waits for a retry.
export const HANDOFF_WINDOW_MS = 30000

/** Where one child's output goes. A handoff moves a child to a new owner. */
export interface ChildOwner {
  /** A line of the child's stdout that parsed as JSON, and the line itself. */
  message(message: any, line: string): void
  nonJson(line: string): void
  stderr(text: string): void
  failure(kind: 'process' | 'stdin' | 'upstream', err: Error): void
  exit(code: number | null, signal: NodeJS.Signals | null): void
  /** What the child's stdout waits for before it is read again, if anything. */
  output(): Promise<void> | undefined
}

/**
 * A session's MCP server, as a link drives it. A child process is one (see
 * processPeer); what the link needs from it is only this.
 */
export interface Peer {
  write(message: JSONRPCMessage): void
  /** No more input: a process finishes what it has, and exits. */
  end(): void
  /** Stops it, and resolves once it is gone. */
  stop(): Promise<void>
  /** Whether it has already ended by itself. */
  readonly gone: boolean
}

/** Starts a peer that delivers everything it says to `owner`. */
export type StartPeer = (owner: ChildOwner) => Peer

/**
 * A child process as a peer: its stdout read as JSON lines, its stderr,
 * failures and exit reported, and its stdout not read while `owner.output()`
 * says to wait.
 */
export const processPeer =
  (
    child: ChildProcessWithoutNullStreams,
    stop: () => Promise<void>,
  ): StartPeer =>
  (owner) => {
    child.on('error', (err) => owner.failure('process', err))
    child.stdin.on('error', (err) => owner.failure('stdin', err))
    child.on('exit', (code, signal) => owner.exit(code, signal))
    const decoder = new StringDecoder('utf8')
    const lines = new LineSplitter()
    child.stdout.on('data', (chunk: Buffer) => {
      lines.push(decoder.write(chunk)).forEach((line) => {
        if (!line.trim()) return
        try {
          owner.message(JSON.parse(line), line)
        } catch {
          owner.nonJson(line)
        }
      })
      holdOutput(child.stdout, owner.output())
    })
    child.stderr.on('data', (chunk: Buffer) =>
      owner.stderr(chunk.toString('utf8')),
    )
    return {
      write: (message) => child.stdin.write(JSON.stringify(message) + '\n'),
      end: () => child.stdin.end(),
      stop,
      get gone() {
        return child.exitCode !== null || child.signalCode !== null
      },
    }
  }

/**
 * One server, delivered to whichever owner holds it.
 *
 * It also remembers the initialize request the server received and whether
 * the server has answered it, which is what decides whether a server abandoned
 * by its client can be handed to the next one (GW-035).
 */
export class ChildLink {
  initialize?: { id: string | number; params: unknown }
  answered = false
  readonly peer: Peer
  readonly stop: () => Promise<void>

  constructor(
    start: StartPeer,
    public owner: ChildOwner,
  ) {
    this.peer = start({
      message: (message, line) => {
        if (
          !('method' in message) &&
          'id' in message &&
          message.id === this.initialize?.id
        )
          this.answered = true
        this.owner.message(message, line)
      },
      nonJson: (line) => this.owner.nonJson(line),
      stderr: (text) => this.owner.stderr(text),
      failure: (kind, err) => this.owner.failure(kind, err),
      exit: (code, signal) => this.owner.exit(code, signal),
      output: () => this.owner.output(),
    })
    this.stop = () => this.peer.stop()
  }

  write(message: JSONRPCMessage) {
    // Only the first initialize is the handshake the child is answering.
    if (!this.initialize && isInitializeRequest(message) && 'id' in message)
      this.initialize = { id: message.id!, params: message.params }
    this.peer.write(message)
  }
}

// Initialize params compared regardless of key order.
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : inner,
  )

type Parked = {
  link: ChildLink
  held: [any, string][]
  ended: boolean
  timer: NodeJS.Timeout
  // Reading the child's stdout again, once someone takes it or it is stopped.
  resume: () => void
}

/**
 * Children whose clients gave up while they were still starting (GW-035).
 *
 * Since 4.1.0 every SSE and WebSocket connection starts its own child. A
 * client whose initialize times out before a slow server has started (5 s in
 * pydantic-ai) used to succeed on its retry, because the one shared child was
 * up by then; with a child per connection every retry started from cold and
 * failed the same way.
 *
 * So a child whose client sent nothing but initialize, and left before it was
 * answered, is not stopped at once. For a short window, the next client whose
 * first message is an identical initialize takes it over, and receives the
 * answer as its own. That child has received one message, the same one the new
 * client sent, and the gateway gives a child nothing else from its client (no
 * headers, no environment), so it is indistinguishable from one started for the
 * new client. No child is started that would not have been, and none earlier:
 * the only difference is that an abandoned child lives up to the window
 * longer. One that nobody takes is stopped as before.
 */
export class ChildHandoff {
  private readonly parked = new Map<string, Parked[]>()

  constructor(
    private readonly logger: Logger,
    private readonly windowMs = HANDOFF_WINDOW_MS,
  ) {}

  /**
   * End a client's hold on its child: park it if it can be handed on, stop it
   * otherwise. `onlyInitialize` says the client sent nothing but initialize.
   */
  release(link: ChildLink, onlyInitialize: boolean, label: string) {
    if (
      !onlyInitialize ||
      !link.initialize ||
      link.answered ||
      link.peer.gone
    ) {
      void link.stop()
      return
    }
    const key = canonical(link.initialize.params)
    // Every way a waiting child ends goes through here, once: the window
    // running out, or the child exiting (as it does when that stops it) or
    // failing.
    const end = (reason: string) => {
      if (entry.ended) return
      entry.ended = true
      clearTimeout(entry.timer)
      this.remove(key, entry)
      this.logger.info(`${label}: stopping the waiting server: ${reason}`)
      entry.resume()
      void link.stop()
    }
    // With nobody to deliver to, the child is not read past what it has
    // already sent: the rest waits in its pipe, as it does for a client that
    // is behind, so waiting costs no memory however much it writes.
    let resume!: () => void
    const unread = new Promise<void>((resolve) => (resume = resolve))
    const entry: Parked = {
      link,
      held: [],
      ended: false,
      timer: setTimeout(
        () => end('no client took it over'),
        this.windowMs,
      ).unref(),
      resume,
    }
    link.owner = {
      message: (message, line) => entry.held.push([message, line]),
      nonJson: (line) =>
        this.logger.error(`${label}: waiting server wrote non-JSON: ${line}`),
      stderr: (text) =>
        this.logger.error(`${label}: waiting server stderr: ${text}`),
      failure: (kind, err) => end(`${kind} failure: ${err.message}`),
      exit: (code, signal) => end(`it exited, code=${code}, signal=${signal}`),
      output: () => unread,
    }
    this.parked.set(key, [...(this.parked.get(key) ?? []), entry])
    this.logger.info(
      `${label}: client left before its initialize was answered; keeping the server ${this.windowMs} ms for a retry`,
    )
  }

  /**
   * The waiting child for this initialize, if there is one. The caller becomes
   * its owner: everything the child said while waiting is replayed to it, and
   * the answer to the original initialize carries the caller's request id.
   */
  adopt(
    message: JSONRPCMessage,
    owner: ChildOwner,
    label: string,
  ): ChildLink | undefined {
    if (!isInitializeRequest(message) || !('id' in message)) return
    const key = canonical(message.params)
    const entry = this.parked.get(key)?.[0]
    if (!entry) return
    entry.ended = true
    clearTimeout(entry.timer)
    this.remove(key, entry)
    const { link } = entry
    const originalId = link.initialize!.id
    let answered = false
    link.owner = {
      ...owner,
      message: (child, line) => {
        if (
          !answered &&
          !('method' in child) &&
          'id' in child &&
          child.id === originalId
        ) {
          answered = true
          child = { ...child, id: message.id }
          line = JSON.stringify(child)
        }
        owner.message(child, line)
      },
    }
    this.logger.info(
      `${label}: took over a server whose previous client left during an identical initialize`,
    )
    entry.held.forEach(([held, line]) => link.owner.message(held, line))
    entry.resume()
    return link
  }

  /** Stop a child nobody will use, without its ending reaching a session. */
  discard(link: ChildLink, label: string) {
    link.owner = {
      message: () => {},
      nonJson: () => {},
      stderr: () => {},
      failure: () => {},
      exit: (code, signal) =>
        this.logger.info(
          `${label}: unused server stopped, code=${code}, signal=${signal}`,
        ),
      output: () => undefined,
    }
    void link.stop()
  }

  private remove(key: string, entry: Parked) {
    const rest = this.parked.get(key)!.filter((other) => other !== entry)
    if (rest.length) this.parked.set(key, rest)
    else this.parked.delete(key)
  }
}
