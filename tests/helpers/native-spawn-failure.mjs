// Select one gateway spawn, then let the OS fail a real exec. This probes native
// asynchronous ENOENT, not host-wide exhaustion or a fabricated EAGAIN event.
import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
if (process.argv[1]?.endsWith('/dist/index.js')) {
  const original = cp.spawn
  let spawned = 0
  cp.spawn = function (...args) {
    if (++spawned === Number(process.env.FAIL_SPAWN_AT ?? 2)) {
      process.stderr.write('AUDIT: native spawn failure selected\n')
      return original('/nonexistent-supergateway-audit-executable', [], {
        ...args[1],
        shell: false,
      })
    }
    return original(...args)
  }
  syncBuiltinESMExports()
}
