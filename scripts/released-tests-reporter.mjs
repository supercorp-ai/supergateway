// A node:test reporter for scripts/released-tests.mjs: one JSON line per
// test that ran, with its file, so the outcome of each can be compared with
// what is expected of it. Suites and skipped tests are left out.
export default async function* reporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue
    const { name, file, nesting, skip, todo, details } = event.data
    if (details?.type === 'suite' || skip !== undefined || todo !== undefined)
      continue
    // A file's own entry: the tests inside it are reported by themselves.
    if (nesting === 0 && file && name === file) continue
    yield `${JSON.stringify({
      file: file ? file.replace(/^.*[\\/]tests[\\/]/, 'tests/') : null,
      name,
      passed: event.type === 'test:pass',
    })}\n`
  }
}
