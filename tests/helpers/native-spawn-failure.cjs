// Select one gateway spawn, then let the OS fail a real exec. This probes native
// asynchronous ENOENT, not host-wide exhaustion or a fabricated EAGAIN event.
//
// Loaded with --require rather than --import: the standalone executable (#50)
// runs --require preloads but ignores --import ones, and CommonJS can still
// update the ESM view of the module for dist/index.js.
const cp = require('node:child_process')
const { syncBuiltinESMExports } = require('node:module')
// NODE_OPTIONS reaches the test's MCP servers too; only the gateway is patched,
// whether it runs as dist/index.js or as the standalone executable.
const executable = (() => {
  try {
    return require('node:sea').isSea()
  } catch {
    return false
  }
})()
if (process.argv[1]?.endsWith('/dist/index.js') || executable) {
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
