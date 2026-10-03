import { spawn } from 'child_process'
import { StringDecoder } from 'node:string_decoder'
import type { Logger } from '../types.js'
import { LineSplitter } from '../lib/lineSplitter.js'
import { onSignals } from '../lib/onSignals.js'
import { OwnedChildProcesses } from '../lib/ownedChildProcesses.js'
import { drained } from '../lib/outputBackpressure.js'
import {
  announceServer,
  startServer,
  type ServerSource,
} from '../lib/serverSource.js'
import type { BridgeLifecycle } from '../lib/stdioBridge.js'

export type CombinedToStdioArgs = ServerSource & {
  logger: Logger
  /** Alone by default: the gateway registers the signals and exits itself. */
  lifecycle?: BridgeLifecycle
}

/**
 * Servers combined as one, on stdio: what a desktop client launches to reach
 * several servers through one entry of its own config. The process is one
 * session. Messages are lines on stdin and stdout, as for any stdio server,
 * and the servers start when the client initializes.
 */
export function combinedToStdio(args: CombinedToStdioArgs) {
  const {
    logger,
    lifecycle = {
      register: (cleanup) => onSignals({ logger, cleanup }),
      exit: (code) => process.exit(code),
    },
  } = args
  announceServer(logger, args)

  const children = new OwnedChildProcesses(logger)
  lifecycle.register(() => children.close())

  const peer = startServer(
    spawn,
    args,
    children,
    logger,
    'Stdio',
  )({
    message: (_message, line) => {
      process.stdout.write(`${line}\n`)
    },
    nonJson: (line) => logger.error(`Server non-JSON: ${line}`),
    stderr: (text) => logger.error(`Server stderr: ${text}`),
    failure: (kind, err) => {
      logger.error(`Server ${kind} failure:`, err)
      lifecycle.exit(1)
    },
    // The session is over: every server has stopped.
    exit: (code, signal) => {
      logger.error(`Servers stopped: code=${code}, signal=${signal}`)
      lifecycle.exit(1)
    },
    // The servers are read no faster than the client reads stdout.
    output: () => drained([process.stdout]),
  })

  const decoder = new StringDecoder('utf8')
  const lines = new LineSplitter()
  process.stdin.on('data', (chunk: Buffer) => {
    lines.push(decoder.write(chunk)).forEach((line) => {
      if (!line.trim()) return
      // Not JSON, or JSON that is no message: said, and the session goes on.
      try {
        peer.write(JSON.parse(line))
      } catch {
        logger.error(`Invalid message on stdin: ${line}`)
      }
    })
  })

  logger.info('Stdio server listening')
}
