import { Logger } from '../types.js'

const log = (...args: any[]) => console.log('[supergateway]', ...args)
const logStderr = (...args: any[]) => console.error('[supergateway]', ...args)

const noneLogger: Logger = {
  info: () => {},
  error: () => {},
}

export const getLogger = ({
  logLevel,
  outputTransport,
}: {
  logLevel: string
  outputTransport: string
}): Logger => {
  if (logLevel === 'none') {
    return noneLogger
  }

  if (outputTransport === 'stdio') {
    return { info: logStderr, error: logStderr }
  }

  return { info: log, error: logStderr }
}
