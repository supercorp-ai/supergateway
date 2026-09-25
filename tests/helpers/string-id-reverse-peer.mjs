// A peer whose own request to the client uses a string id, which the SDK's
// server never does. On a client request it first pings the client with id
// "srv-ping", and answers the client only once that ping's reply comes back
// with the same id.
import { createInterface } from 'node:readline'

const write = (message) => process.stdout.write(JSON.stringify(message) + '\n')
let waiting
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if ('method' in message && 'id' in message) {
    waiting = message.id
    write({ jsonrpc: '2.0', id: 'srv-ping', method: 'ping' })
  } else if (message.id === 'srv-ping' && waiting !== undefined) {
    write({ jsonrpc: '2.0', id: waiting, result: { pingAnswered: true } })
    waiting = undefined
  }
})
