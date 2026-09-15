// Writes a very large amount to stdout with no newline in it, then stops.
// The gateways all accumulate `buffer += chunk` and only split on newlines, so
// this is what an unbounded buffer looks like from the child's side.
const MB = Number(process.env.FLOOD_MB ?? 256)
const chunk = 'x'.repeat(1024 * 1024)
for (let i = 0; i < MB; i++) {
  if (!process.stdout.write(chunk)) {
    await new Promise((resolve) => process.stdout.once('drain', resolve))
  }
}
// Never writes a newline; never exits on its own.
setInterval(() => {}, 1 << 30)
