import util from 'node:util'
import { Logger } from '../types.js'
import { jsonLogger } from './jsonLogger.js'

const defaultFormatArgs = (args: any[]) => args

const log =
  ({
    formatArgs = defaultFormatArgs,
  }: {
    formatArgs?: typeof defaultFormatArgs
  } = {}) =>
  (...args: any[]) =>
    console.log('[supergateway]', ...formatArgs(args))

const logStderr =
  ({
    formatArgs = defaultFormatArgs,
  }: {
    formatArgs?: typeof defaultFormatArgs
  } = {}) =>
  (...args: any[]) =>
    console.error('[supergateway]', ...formatArgs(args))

const noneLogger: Logger = {
  info: () => {},
  error: () => {},
}

const infoLogger: Logger = {
  info: log(),
  error: logStderr(),
}

const infoLoggerStdio: Logger = {
  info: logStderr(),
  error: logStderr(),
}

const debugFormatArgs = (args: any[]) =>
  args.map((arg) => {
    if (typeof arg === 'object') {
      return util.inspect(arg, {
        depth: null,
        colors: process.stderr.isTTY,
        compact: false,
      })
    }

    return arg
  })

const debugLogger: Logger = {
  info: log({ formatArgs: debugFormatArgs }),
  error: logStderr({ formatArgs: debugFormatArgs }),
}

const debugLoggerStdio: Logger = {
  info: logStderr({ formatArgs: debugFormatArgs }),
  error: logStderr({ formatArgs: debugFormatArgs }),
}

/**
 * The logger the settings ask for. `server` names the config entry its lines
 * are about, for a gateway that serves more than one: `[name]` after
 * `[supergateway]` in text, a `server` field in JSON.
 */
export const getLogger = ({
  logLevel,
  outputTransport,
  logFormat = 'text',
  server,
}: {
  logLevel: string
  outputTransport: string
  logFormat?: string
  server?: string
}): Logger => {
  if (logLevel === 'none') {
    return noneLogger
  }

  // `debug` only changes how text renders objects; JSON has one rendering.
  if (logFormat === 'json') {
    return jsonLogger(outputTransport, server)
  }

  const text =
    logLevel === 'debug'
      ? outputTransport === 'stdio'
        ? debugLoggerStdio
        : debugLogger
      : // info logLevel
        outputTransport === 'stdio'
        ? infoLoggerStdio
        : infoLogger
  if (server === undefined) return text
  return {
    info: (...args) => text.info(`[${server}]`, ...args),
    error: (...args) => text.error(`[${server}]`, ...args),
  }
}
