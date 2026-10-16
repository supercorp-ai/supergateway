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
// Windows has no signals between processes: one process "signalling" another
// terminates it. Its console delivers Ctrl+C (SIGINT), Ctrl+Break (SIGBREAK)
// and a closed window (SIGHUP) to the process's own handlers, so the test
// raises the signal here, as the console would.
process.on('message', (signal) => process.emit(signal, signal))
// The channel must not keep this process alive once the gateway is done.
process.channel?.unref()
console.log('owner ready')
