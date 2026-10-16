// What npx, uvx and most launchers are: a process that runs the server as its
// own child, with the same stdio, and forwards nothing. Ending the wrapper
// alone leaves the server running.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

writeFileSync(join(process.env.CLEANUP_PIDS, `wrapper-${process.pid}`), '')
const server = spawn(
  process.execPath,
  [fileURLToPath(new URL('./stubborn-peer.mjs', import.meta.url))],
  { stdio: 'inherit' },
)
server.on('exit', (code) => process.exit(code ?? 1))
