// A server a health check finds unhealthy, as argv[2] says:
// - exit <code>: exits at once, as a server that cannot start does;
// - refuse: answers initialize with an error, as one that is up but broken.
import { createInterface } from 'node:readline'

if (process.argv[2] === 'exit') process.exit(Number(process.argv[3]))

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line)
  if (message.method !== 'initialize') continue
  process.stdout.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32603, message: 'database unavailable' },
    }) + '\n',
  )
}
