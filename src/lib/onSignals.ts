import { Logger } from '../types.js'

export interface OnSignalsOptions {
  logger: Logger
  cleanup?: () => void | Promise<void>
  drainStdin?: boolean
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

  process.on('SIGINT', () => shutdown('Caught SIGINT. Exiting...'))
  process.on('SIGTERM', () => shutdown('Caught SIGTERM. Exiting...'))
  process.on('SIGHUP', () => shutdown('Caught SIGHUP. Exiting...'))
  process.stdin.on('close', () => shutdown('stdin closed. Exiting...'))
  // Network-output gateways do not otherwise read stdin, so EOF would never
  // be observed. Stdio-input bridges must let their transport consume it.
  if (options.drainStdin) process.stdin.resume()
}
