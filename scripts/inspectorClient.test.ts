// The MCP Inspector's CLI as a client of every gateway path it can speak,
// compared with the Inspector talking to the same server directly. Soak-only,
// like realServers.test.ts: it downloads a pinned Inspector and server, so it
// is not part of `npm test`, which stays offline. Run it with
//
//   SUPERGATEWAY_REAL_SERVERS=1 node --import tsx --test scripts/inspectorClient.test.ts
//
// The Inspector is where most people first try a server, and it is not the SDK
// client every other test uses: one process per call, the legacy protocol era
// an ad-hoc run negotiates, and its own argument handling. As a stdio client it
// also launches both bridges, the way an MCP host does. It has no WebSocket
// transport. POSIX only, like the real servers.
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchGateway, unusedPort } from '../tests/helpers/gateway-process.js'
import { realServers } from './real-servers/servers.js'

const enabled =
  process.env.SUPERGATEWAY_REAL_SERVERS === '1' && process.platform !== 'win32'
const entry = process.env.SUPERGATEWAY_TEST_ENTRY ?? 'dist/index.js'
const INSPECTOR = '@modelcontextprotocol/inspector@2.8.0'

// Installed once per machine; later runs start from it.
function installInspector() {
  const root = join(tmpdir(), 'supergateway-soak-inspector-2.8.0')
  const bin = join(
    root,
    'node_modules/@modelcontextprotocol/inspector/clients/launcher/build/index.js',
  )
  if (!existsSync(bin))
    execFileSync(
      'npm',
      ['install', '--prefix', root, '--no-audit', '--no-fund', INSPECTOR],
      { stdio: 'ignore', timeout: 5 * 60000 },
    )
  return bin
}

// The same questions realServers.test.ts asks server-everything, as Inspector
// options. Each call is a fresh Inspector process.
const CALLS: Array<[label: string, options: string[]]> = [
  ['tools/list', ['--method', 'tools/list']],
  [
    'tools/call echo',
    [
      ...['--method', 'tools/call', '--tool-name', 'echo'],
      ...['--tool-arg', 'message=héllo – 🙂   end'],
    ],
  ],
  [
    'tools/call get-sum',
    [
      ...['--method', 'tools/call', '--tool-name', 'get-sum'],
      ...['--tool-arg', 'a=19', '--tool-arg', 'b=23'],
    ],
  ],
  [
    'tools/call get-structured-content',
    [
      ...['--method', 'tools/call', '--tool-name', 'get-structured-content'],
      ...['--tool-arg', 'location=Chicago'],
    ],
  ],
  ['resources/list', ['--method', 'resources/list']],
  [
    'resources/read static',
    [
      ...['--method', 'resources/read'],
      ...['--uri', 'demo://resource/static/document/architecture.md'],
    ],
  ],
  [
    'resources/read template',
    ['--method', 'resources/read', '--uri', 'demo://resource/dynamic/text/2'],
  ],
  ['prompts/list', ['--method', 'prompts/list']],
  [
    'prompts/get args-prompt',
    [
      ...['--method', 'prompts/get', '--prompt-name', 'args-prompt'],
      ...['--prompt-args', 'city=Vilnius', 'state=LT'],
    ],
  ],
]

/** Every call's JSON answer, or what came out instead of one. */
async function observe(
  bin: string,
  target: string[],
  transport: string[],
  normalize?: (json: string) => string,
) {
  const observed: Record<string, unknown> = {}
  for (const [label, options] of CALLS) {
    // The Inspector reads the target before `--` and its own options after it,
    // the reverse of the usual convention. Without `--` the target ends at its
    // first flag, and npx's -y becomes an Inspector option.
    const { stdout, stderr } = await new Promise<{
      stdout: string
      stderr: string
    }>((resolve) =>
      execFile(
        process.execPath,
        [
          ...[bin, '--cli', ...target, '--', ...options, ...transport],
          ...['--format', 'json'],
        ],
        { timeout: 120000, maxBuffer: 16 * 1024 * 1024 },
        (_error, stdout, stderr) => resolve({ stdout, stderr }),
      ),
    )
    try {
      observed[label] = JSON.parse(stdout)
    } catch {
      observed[label] = {
        unparsable: stdout.slice(0, 2000),
        stderr: stderr.slice(-2000),
      }
    }
  }
  const json = JSON.stringify(observed)
  return JSON.parse(normalize?.(json) ?? json) as Record<string, object>
}

const shellWord = (word: string) =>
  /^[\w@./:=,-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`

const gatewayFor = async (t: TestContext, argv: string[], output: string[]) => {
  const port = await unusedPort()
  const gateway = launchGateway(t, [
    '--stdio',
    argv.map(shellWord).join(' '),
    '--port',
    String(port),
    ...output,
  ])
  await gateway.ready()
  return `127.0.0.1:${port}`
}

type Target = [target: string[], transport: string[]]
const bridge = (flag: string, url: string): Target => [
  [process.execPath, entry, flag, url, '--logLevel', 'none'],
  [],
]
const PATHS: Array<{
  name: string
  target: (t: TestContext, argv: string[]) => Promise<Target>
  /** What this path is meant to change about the direct answers. */
  expect?: (direct: Record<string, object>) => Record<string, object>
}> = [
  {
    name: 'SSE',
    target: async (t, argv) => [
      [`http://${await gatewayFor(t, argv, ['--outputTransport', 'sse'])}/sse`],
      ['--transport', 'sse'],
    ],
  },
  {
    name: 'stateful HTTP',
    // The Inspector CLI exits without ending its session, so the gateway keeps
    // each call's child until the session times out. A short timeout stops
    // nine one-call sessions holding nine servers at once.
    target: async (t, argv) => [
      [
        `http://${await gatewayFor(t, argv, ['--outputTransport', 'streamableHttp', '--stateful', '--sessionTimeout', '2000'])}/mcp`,
      ],
      ['--transport', 'http'],
    ],
  },
  {
    name: 'stateless HTTP',
    target: async (t, argv) => [
      [
        `http://${await gatewayFor(t, argv, ['--outputTransport', 'streamableHttp'])}/mcp`,
      ],
      ['--transport', 'http'],
    ],
    // Stateless children cannot send the client requests (GW-026), so the
    // gateway initializes them with no client capabilities, and
    // server-everything withholds the one tool it offers only to a client
    // that declares roots. Everything else must match.
    expect: (direct) => {
      const copy = structuredClone(direct) as Record<string, any>
      copy['tools/list'].result.tools = copy['tools/list'].result.tools.filter(
        ({ name }: { name: string }) => name !== 'get-roots-list',
      )
      return copy
    },
  },
  {
    name: 'SSE bridge',
    target: async (t, argv) =>
      bridge(
        '--sse',
        `http://${await gatewayFor(t, argv, ['--outputTransport', 'sse'])}/sse`,
      ),
  },
  {
    name: 'Streamable HTTP bridge',
    target: async (t, argv) =>
      bridge(
        '--streamableHttp',
        `http://${await gatewayFor(t, argv, ['--outputTransport', 'streamableHttp', '--stateful'])}/mcp`,
      ),
  },
]

test(
  'the Inspector CLI sees server-everything identically through every gateway path',
  {
    skip: !enabled && 'set SUPERGATEWAY_REAL_SERVERS=1 (POSIX)',
    timeout: 20 * 60000,
  },
  async (t) => {
    const server = realServers({ files: '', repo: '' }).find(
      ({ name }) => name === 'server-everything',
    )!
    const bin = installInspector()
    const direct = () => observe(bin, server.argv, [], server.normalize)

    // As in realServers.test.ts: two direct runs must agree before any
    // difference can be blamed on the gateway, and every call must have
    // succeeded, or agreeing would prove little.
    const expected = await direct()
    assert.deepEqual(
      await direct(),
      expected,
      'the Inspector script is not deterministic without a gateway',
    )
    for (const [label, answer] of Object.entries(expected))
      assert.ok(
        'result' in answer,
        `${label} failed without a gateway: ${JSON.stringify(answer).slice(0, 500)}`,
      )

    for (const path of PATHS) {
      const [target, transport] = await path.target(t, server.argv)
      assert.deepEqual(
        await observe(bin, target, transport, server.normalize),
        path.expect?.(expected) ?? expected,
        `the Inspector through ${path.name} differs from a direct connection`,
      )
    }
  },
)
