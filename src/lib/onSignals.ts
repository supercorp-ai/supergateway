import { Logger } from '../types.js'

export interface OnSignalsOptions {
  logger: Logger
  cleanup?: () => void | Promise<void>
  drainStdin?: boolean
}

// The shutdown of whichever gateway is running. Each process runs exactly one
// gateway, which registers it once; requestShutdown lets anything else in the
// process stop it the same way a signal does.
let registered: ((message: string) => void) | undefined

/**
 * Shuts down the way SIGTERM does: logs `message`, runs the gateway's cleanup
 * (stopping its children, ending an upstream session) and exits. Before a
 * gateway has registered there is nothing to clean up, so it just exits.
 *
 * Not a real signal: on Windows `process.kill(process.pid, 'SIGTERM')`
 * terminates without running any handler, and emitting one would log
 * "Caught SIGTERM" for something that was not.
 */
export function requestShutdown(message: string): void {
  if (registered) registered(message)
  else process.exit(0)
}

/**
 * Sets up signal handlers for graceful shutdown.
 *
 * @param options Configuration options
 * @param options.logger Logger instance
 * @param options.cleanup Optional cleanup function to be called before exit
 */
export function onSignals(options: OnSignalsOptions): void {
  const { logger, cleanup } = options

  let stopping = false
  const shutdown = (message: string) => {
    if (stopping) return
    stopping = true
    logger.info(message)
    const pending = cleanup?.()
    if (pending) {
      void pending
        .then(() => process.exit(0))
        .catch((error) => {
          logger.error('Shutdown cleanup failed:', error)
          process.exit(1)
        })
    } else {
      process.exit(0)
    }
  }

  registered = shutdown

  process.on('SIGINT', () => shutdown('Caught SIGINT. Exiting...'))
  process.on('SIGTERM', () => shutdown('Caught SIGTERM. Exiting...'))
  process.on('SIGHUP', () => shutdown('Caught SIGHUP. Exiting...'))
  process.stdin.on('close', () => shutdown('stdin closed. Exiting...'))
  // Network-output gateways do not otherwise read stdin, so EOF would never
  // be observed. Stdio-input bridges must let their transport consume it.
  if (options.drainStdin) process.stdin.resume()
}
