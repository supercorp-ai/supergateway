// Deliberately ordinary wrapper: inherited stdio, no process group of its own,
// and no signal forwarding. A gateway must not confuse its PID with the peer.
import { spawn } from 'node:child_process'
const child = spawn(process.execPath, ['tests/helpers/fault-peer.mjs'], {
  stdio: 'inherit',
  env: { ...process.env, FAULT_WRAPPER_PID: String(process.pid) },
})
child.on('exit', (code) => process.exit(code ?? 1))
