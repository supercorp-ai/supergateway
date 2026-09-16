// Loaded only by lifecycle tests launched with --expose-gc.
setInterval(() => {
  global.gc()
  process.stderr.write('[gc-pressure] collected\n')
}, 25).unref()
