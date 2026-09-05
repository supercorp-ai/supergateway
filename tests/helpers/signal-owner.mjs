import { onSignals } from '../../dist/lib/onSignals.js'

onSignals({
  logger: {
    info: (message) => console.log(message),
    error: (message) => console.error(message),
  },
  ...(process.argv[2] === 'cleanup'
    ? { cleanup: () => console.log('owner cleanup') }
    : {}),
})
process.stdin.resume()
console.log('owner ready')
