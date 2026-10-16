// Test-only, on Windows: a signal for the gateway arrives as its console would
// deliver one. Windows has no signals between processes (one process
// "signalling" another terminates it); the console raises Ctrl+C (SIGINT),
// Ctrl+Break (SIGBREAK) and a closed window (SIGHUP) in the process itself, and
// that is what runs the gateway's shutdown. launchGateway preloads this and
// sends the signal's name over the IPC channel it opens. CommonJS, for
// --require: the standalone executable runs those preloads, not --import ones.
process.on('message', (signal) => process.emit(signal, signal))
// The channel must not keep the gateway alive.
process.channel?.unref()
