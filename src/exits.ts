import type { Logger } from './types.js'

// Startup ends here: the problem is logged, and the gateway exits 1.
export function exitWithError(logger: Logger, message: string): never {
  logger.error(message)
  process.exit(1)
}

// What a startup check found, or, when it found a problem, exit 1 after
// logging it.
export function orExit<T extends object>(
  logger: Logger,
  result: T | { error: string },
): T {
  if ('error' in result) exitWithError(logger, result.error)
  return result as T
}

// `--printConfig`'s output, after which the gateway exits.
export function printAndExit(value: unknown): never {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  process.exit(0)
}
