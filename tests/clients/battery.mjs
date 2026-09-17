// The Node half of the cross-client conformance battery.
//
// Runs the same scenarios the other language drivers run, so the results line up
// into a matrix. This one is the baseline: it uses the same SDK the gateway
// does, so anything failing here is the gateway, while anything failing only in
// another client is a disagreement between implementations.
const sdk = process.env.BATTERY_SDK ?? '@modelcontextprotocol/sdk'
const { Client } = await import(`${sdk}/client/index.js`)
const { SSEClientTransport } = await import(`${sdk}/client/sse.js`)
const StreamableHTTPClientTransport =
  process.argv[3] === 'sse'
    ? undefined
    : (await import(`${sdk}/client/streamableHttp.js`))
        .StreamableHTTPClientTransport

const URL_ = process.argv[2]
const KIND = process.argv[3]

const SEPARATORS = 'before' + '\u2028' + 'middle' + '\u2029' + 'after'
const UNICODE = 'a👩‍👩‍👧‍👦b عربى c éèê d 漢字 e 𝔘𝔫𝔦 f'
const PLAIN = 'plain-result'
const BIG_LENGTH = Number(process.env.BIG_LENGTH ?? 1024 * 1024)

const results = []
const record = (name, ok, detail = '') => results.push({ name, ok, detail })

const text = (res) => res?.content?.find((c) => c.type === 'text')?.text

const client = new Client(
  { name: 'battery-node', version: '1.0.0' },
  { capabilities: {} },
)
const transport =
  KIND === 'sse'
    ? new SSEClientTransport(new URL(URL_))
    : new StreamableHTTPClientTransport(new URL(URL_))

try {
  await client.connect(transport)
  record('connect', true, client.getServerVersion?.()?.name ?? '')
} catch (e) {
  record('connect', false, String(e.message).slice(0, 80))
  console.log(JSON.stringify(results))
  process.exit(0)
}

const call = async (name, args = {}) =>
  client.callTool({ name, arguments: args })

try {
  const tools = (await client.listTools()).tools.map((t) => t.name).sort()
  const want = [
    'echo',
    'large',
    'plain',
    'separators',
    'shadowedError',
    'slow',
    'throws',
    'toolError',
    'unicode',
  ]
  record(
    'tools/list',
    JSON.stringify(tools) === JSON.stringify(want),
    tools.join(),
  )
} catch (e) {
  record('tools/list', false, String(e.message).slice(0, 60))
}

for (const [name, tool, expect] of [
  ['plain text', 'plain', PLAIN],
  ['line separators', 'separators', SEPARATORS],
  ['unicode', 'unicode', UNICODE],
]) {
  try {
    const got = text(await call(tool))
    record(
      name,
      got === expect,
      got === expect ? '' : `got ${JSON.stringify(got).slice(0, 60)}`,
    )
  } catch (e) {
    record(name, false, String(e.message).slice(0, 60))
  }
}

try {
  const got = text(await call('large'))
  record('1 MB result', got?.length === BIG_LENGTH, `length ${got?.length}`)
} catch (e) {
  record('1 MB result', false, String(e.message).slice(0, 60))
}

try {
  const res = await call('toolError')
  record(
    'tool error stays a result',
    res?.isError === true,
    `isError=${res?.isError}`,
  )
} catch (e) {
  record(
    'tool error stays a result',
    false,
    `threw: ${String(e.message).slice(0, 50)}`,
  )
}

try {
  const res = await call('throws')
  // The SDK surfaces a thrown tool as an isError result rather than rejecting.
  record(
    'throwing tool reported',
    res?.isError === true || Boolean(text(res)),
    `isError=${res?.isError}`,
  )
} catch (e) {
  record(
    'throwing tool reported',
    true,
    `rejected: ${String(e.message).slice(0, 40)}`,
  )
}

try {
  const args = {
    text: UNICODE,
    number: -0.5,
    flag: false,
    nested: { a: [1, null, true], b: { c: SEPARATORS } },
  }
  const got = JSON.parse(text(await call('echo', args)))
  record(
    'arguments round trip',
    JSON.stringify(got) === JSON.stringify(args),
    JSON.stringify(got).slice(0, 70),
  )
} catch (e) {
  record('arguments round trip', false, String(e.message).slice(0, 60))
}

try {
  const started = Date.now()
  const got = text(await call('slow'))
  record(
    'slow call completes',
    got === 'slow-done',
    `${Date.now() - started}ms`,
  )
} catch (e) {
  record('slow call completes', false, String(e.message).slice(0, 60))
}

try {
  const res = await call('shadowedError')
  record(
    'result with an error field',
    text(res) === 'ok',
    `text=${JSON.stringify(text(res))}`,
  )
} catch (e) {
  record('result with an error field', false, String(e.message).slice(0, 60))
}

try {
  const got = await Promise.all(Array.from({ length: 5 }, () => call('plain')))
  record(
    '5 concurrent calls',
    got.every((r) => text(r) === PLAIN),
    `${got.length} replies`,
  )
} catch (e) {
  record('5 concurrent calls', false, String(e.message).slice(0, 60))
}

try {
  const res = await call('noSuchTool')
  record(
    'unknown tool errors',
    Boolean(res?.isError),
    `isError=${res?.isError}`,
  )
} catch (e) {
  record(
    'unknown tool errors',
    true,
    `rejected: ${String(e.message).slice(0, 40)}`,
  )
}

await client.close().catch(() => {})
console.log(JSON.stringify(results))
