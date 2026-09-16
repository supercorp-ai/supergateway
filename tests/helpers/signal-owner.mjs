import { onSignals } from '../../dist/lib/onSignals.js'

onSignals({
  logger: {
    info: (message) => console.log(message),
    error: (message) => console.error(message),
  },
  ...(process.argv[2] === 'cleanup'
    ? { cleanup: () => console.log('owner cleanup') }
    : ['resolve', 'reject'].includes(process.argv[2])
      ? {
          cleanup: () => {
            console.log('owner cleanup')
            return new Promise((resolve, reject) =>
              setTimeout(() => {
                console.log('owner cleanup settled')
                return process.argv[2] === 'reject'
                  ? reject(new Error('cleanup rejected'))
                  : resolve()
              }, 200),
            )
          },
        }
      : {}),
})
process.stdin.resume()
console.log('owner ready')
