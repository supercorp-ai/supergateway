// Calls requestShutdown the way --exitWithProcess does, with or without a
// gateway's shutdown registered first.
import { onSignals, requestShutdown } from '../../dist/lib/onSignals.js'

const logger = {
  info: (message) => console.log(message),
  error: (message) => console.error(message),
}
if (process.argv[2] === 'registered')
  onSignals({
    logger,
    cleanup: () => {
      console.log('owner cleanup')
      return new Promise((resolve) =>
        setTimeout(() => {
          console.log('owner cleanup settled')
          resolve()
        }, 100),
      )
    },
  })
requestShutdown('Shutdown requested. Exiting...')
// Only reachable while an asynchronous cleanup is still running; a second
// request then must not start another one.
requestShutdown('Shutdown requested twice. Exiting...')
console.log('after request')
