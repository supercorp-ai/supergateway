// Machine-readable outcomes retain failure diagnostics for baseline comparison.
export default async function* reporter(events) {
  for await (const event of events) {
    if (!['test:pass', 'test:fail', 'test:summary'].includes(event.type))
      continue
    const { name, file, skip, todo, details, ...rest } = event.data
    yield JSON.stringify(
      { type: event.type, name, file, skip, todo, details, ...rest },
      (key, value) =>
        value instanceof Error
          ? {
              message: value.message,
              stack: value.stack,
              cause: value.cause,
              actual: value.actual,
              expected: value.expected,
              code: value.code,
            }
          : value,
    ) + '\n'
  }
}
