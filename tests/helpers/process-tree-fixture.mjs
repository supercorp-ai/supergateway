// A controlled parent with nine children, used to prove the leak budget is live.
import { spawn } from 'node:child_process'
import { once } from 'node:events'
const children = Array.from({ length: 9 }, () =>
  spawn(
    process.execPath,
    [
      '-e',
      "process.send('ready'); process.on('message', () => {}); process.on('disconnect', () => process.exit(0))",
    ],
    {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  ),
)
const exits = children.map((child) => once(child, 'exit'))
const ready = Promise.all(children.map((child) => once(child, 'message')))
let closing = false
async function close() {
  if (closing) return
  closing = true
  for (const child of children) child.kill()
  await Promise.all(exits)
  process.exit(0)
}
process.on('message', close)
process.on('disconnect', close)
await ready
process.send({ pids: children.map((child) => child.pid) })
