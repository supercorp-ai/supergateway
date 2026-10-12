import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import { StringDecoder } from 'node:string_decoder'
import { LineSplitter } from './lineSplitter.js'
import { holdOutput } from './outputBackpressure.js'

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
