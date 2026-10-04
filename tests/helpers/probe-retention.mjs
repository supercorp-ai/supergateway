// Loaded only by retention tests, into a gateway started with --expose-gc.
//
// Counts the session liveness probes the gateway closes, and how many of those
// the garbage collector has since reclaimed. A closed session that stays
// reachable keeps its probe, and with it the session's transport and server,
// for the life of the gateway. Reported on stderr whenever either count moves.
import { pathToFileURL } from 'node:url'

// The probe module the gateway itself loads, next to its entry point.
const { SessionLivenessProbe } = await import(
  new URL('lib/sessionLivenessProbe.js', pathToFileURL(process.argv[1])).href
)
let closed = 0
let collected = 0
const seen = new WeakSet()
const registry = new FinalizationRegistry(() => {
  collected++
})
const close = SessionLivenessProbe.prototype.close
SessionLivenessProbe.prototype.close = function () {
  if (!seen.has(this)) {
    seen.add(this)
    closed++
    registry.register(this, undefined)
  }
  return close.call(this)
}
let reported = ''
setInterval(() => {
  global.gc()
  const line = `[probe-retention] closed=${closed} collected=${collected}`
  if (line === reported) return
  reported = line
  process.stderr.write(line + '\n')
}, 25).unref()
