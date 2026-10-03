import { test } from 'node:test'
import assert from 'node:assert/strict'
import { givenOptions, parseCli } from '../src/cli.js'
import {
  GATEWAY_FLAGS,
  cliForEntry,
  configFromCli,
  entryFlagBesideConfig,
  overrideFromCli,
  printableConfig,
} from '../src/config/cliConfig.js'
import {
  loadConfig,
  type Config,
  type Entry,
} from '../src/config/configFile.js'
import { describeCommand, spawnCommand } from '../src/lib/childCommand.js'
import { apiKeysOf } from '../src/lib/apiKey.js'

// The command line and the config file as two spellings of one thing: the
// config a command line is equivalent to, the command line an entry runs as,
// what may sit beside --config, and how a child is started from either.

const cli = (args: string[]) => ({
  argv: parseCli(args),
  given: givenOptions(args),
})

const fromCli = (args: string[]) => {
  const { argv, given } = cli(args)
  return configFromCli(argv, given)
}

const loaded = (value: unknown): Config => {
  const result = loadConfig('c.json', JSON.stringify(value), {})
  assert.ok('config' in result, JSON.stringify(result))
  return result.config
}

// --- What the command line gives ---

test('givenOptions: the declared options typed, by the name yargs files them', () => {
  assert.deepEqual(
    givenOptions([
      '--stdio',
      'node server.js --port 1',
      '--port=9',
      '--log-level',
      'debug',
      '--no-stateful',
      '--keepAlive',
      '-xy',
      'positional',
    ]),
    new Set(['stdio', 'port', 'logLevel', 'stateful']),
  )
  assert.deepEqual(givenOptions([]), new Set())
  assert.deepEqual(
    givenOptions(['--config', 'c.json', '--printConfig', '--check-config']),
    new Set(['config', 'printConfig', 'checkConfig']),
  )
})

test('the gateway-wide flags are exactly the ones allowed beside --config', () => {
  assert.deepEqual(
    [...GATEWAY_FLAGS],
    [
      'port',
      'host',
      'logLevel',
      'logFormat',
      'exitWithProcess',
      'healthEndpoint',
      'apiKey',
      'apiKeyFile',
    ],
  )
})

test('entryFlagBesideConfig: a server or URL flag beside --config is named', () => {
  assert.equal(
    entryFlagBesideConfig(
      new Set(['config', 'printConfig', 'checkConfig', ...GATEWAY_FLAGS]),
    ),
    undefined,
  )
  for (const flag of [
    'stdio',
    'sse',
    'streamableHttp',
    'outputTransport',
    'baseUrl',
    'ssePath',
    'messagePath',
    'streamableHttpPath',
    'cors',
    'healthCheck',
    'toolPrefix',
    'tools',
    'header',
    'oauth2Bearer',
    'stateful',
    'sessionTimeout',
    'protocolVersion',
  ])
    assert.equal(
      entryFlagBesideConfig(new Set(['config', 'port', flag])),
      flag,
      flag,
    )
})

// --- The config a command line is equivalent to ---

test('configFromCli: a bare --stdio is one entry, "default", served at /', () => {
  assert.deepEqual(fromCli(['--stdio', 'npx -y pkg']), {
    gateway: {},
    defaults: {},
    entries: [
      {
        name: 'default',
        path: '/',
        server: { source: { kind: 'stdio', stdio: 'npx -y pkg' } },
      },
    ],
  })
})

test('configFromCli: remote servers', () => {
  assert.deepEqual(fromCli(['--sse', 'http://h/sse']).entries[0].server, {
    source: { kind: 'url', url: 'http://h/sse', type: 'sse' },
  })
  assert.deepEqual(
    fromCli(['--streamableHttp', 'http://h/mcp']).entries[0].server,
    { source: { kind: 'url', url: 'http://h/mcp', type: 'streamableHttp' } },
  )
})

test('configFromCli: every flag given is carried, and only those', () => {
  assert.deepEqual(
    fromCli([
      '--stdio',
      'srv',
      '--port',
      '9000',
      '--host',
      '127.0.0.1',
      '--logLevel',
      'debug',
      '--logFormat',
      'json',
      '--exitWithProcess',
      '4242',
      '--healthEndpoint',
      '/healthz',
      '--healthEndpoint',
      'ready',
      '--outputTransport',
      'streamableHttp',
      '--baseUrl',
      'http://public',
      '--ssePath',
      'events',
      '--messagePath',
      '/msgs',
      '--streamableHttpPath',
      '/rpc',
      '--cors',
      'http://a.example',
      '--cors',
      '/b$/',
      '--header',
      'x-team:  core ',
      '--header',
      'Authorization: Bearer a:b',
      '--header',
      'no-colon',
      '--header',
      ':no-name',
      '--oauth2Bearer',
      'tok',
      '--apiKey',
      'k1',
      '--apiKey',
      'k2',
      '--apiKeyFile',
      '/run/keys',
      '--stateful',
      '--sessionTimeout',
      '5000',
      '--protocolVersion',
      '2025-03-26',
      '--healthCheck',
      'server',
      '--toolPrefix',
      'gh_',
      '--tools',
      'search',
      '--tools',
      'get',
    ]),
    {
      gateway: {
        port: 9000,
        host: '127.0.0.1',
        logLevel: 'debug',
        logFormat: 'json',
        exitWithProcess: 4242,
        healthEndpoint: ['/healthz', '/ready'],
      },
      defaults: {},
      entries: [
        {
          name: 'default',
          path: '/',
          outputTransport: 'streamableHttp',
          baseUrl: 'http://public',
          ssePath: '/events',
          messagePath: '/msgs',
          streamableHttpPath: '/rpc',
          cors: ['http://a.example', '/b$/'],
          healthCheck: 'server',
          toolPrefix: 'gh_',
          tools: ['search', 'get'],
          headers: { 'x-team': 'core', Authorization: 'Bearer a:b' },
          oauth2Bearer: 'tok',
          apiKey: ['k1', 'k2'],
          apiKeyFile: '/run/keys',
          stateful: true,
          sessionTimeout: 5000,
          protocolVersion: '2025-03-26',
          server: { source: { kind: 'stdio', stdio: 'srv' } },
        },
      ],
    },
  )
})

test('configFromCli: --cors with no origin allows every origin', () => {
  assert.equal(fromCli(['--stdio', 'x', '--cors']).entries[0].cors, true)
})

test('configFromCli: an empty --toolPrefix is none; a bare --tools is no tools', () => {
  const [entry] = fromCli([
    '--stdio',
    'x',
    '--toolPrefix',
    '',
    '--tools',
  ]).entries
  assert.equal(entry.toolPrefix, undefined)
  assert.deepEqual(entry.tools, [])
})

test('configFromCli: --header with no value is no headers', () => {
  assert.deepEqual(fromCli(['--stdio', 'x', '--header']).entries[0].headers, {})
})

// --- Flags beside --config ---

const fileConfig = (): Config =>
  loaded({
    port: 8000,
    healthEndpoint: '/x',
    mcpServers: { a: { command: 'srv' } },
  })

const override = (args: string[]) => {
  const { argv, given } = cli(['--config', 'c.json', ...args])
  return overrideFromCli(fileConfig(), argv, given)
}

test('overrideFromCli: nothing given changes nothing', () => {
  const config = fileConfig()
  const { argv, given } = cli(['--config', 'c.json'])
  assert.deepEqual(overrideFromCli(config, argv, given), {
    config,
    extraKeys: [],
    extraKeyFiles: [],
    notes: [],
  })
})

test("overrideFromCli: each gateway flag replaces the file's, and says so", () => {
  const config = fileConfig()
  const { argv, given } = cli([
    '--config',
    'c.json',
    '--port',
    '9',
    '--host',
    '::1',
    '--logLevel',
    'none',
    '--logFormat',
    'json',
    '--exitWithProcess',
    '77',
    '--healthEndpoint',
    '/a',
    '--healthEndpoint',
    'b',
  ])
  const result = overrideFromCli(config, argv, given)
  assert.deepEqual(result.config.gateway, {
    port: 9,
    host: '::1',
    logLevel: 'none',
    logFormat: 'json',
    exitWithProcess: 77,
    healthEndpoint: ['/a', '/b'],
  })
  assert.deepEqual(result.notes, [
    '--port 9 overrides "port": 8000 from the config file',
    '--host "::1" overrides the default from the config file',
    '--logLevel "none" overrides the default from the config file',
    '--logFormat "json" overrides the default from the config file',
    '--exitWithProcess 77 overrides the default from the config file',
    '--healthEndpoint ["/a","/b"] overrides "healthEndpoint": ["/x"] from the config file',
  ])
  assert.deepEqual(result.config.entries, config.entries)
  assert.deepEqual(
    config.gateway,
    { port: 8000, healthEndpoint: ['/x'] },
    'the loaded config is left as it was',
  )
})

test('overrideFromCli: --apiKey and --apiKeyFile are added, not replaced', () => {
  const result = override([
    '--apiKey',
    'k1',
    '--apiKey',
    'k2',
    '--apiKeyFile',
    '/run/keys',
  ])
  assert.deepEqual(result.extraKeys, ['k1', 'k2'])
  assert.deepEqual(result.extraKeyFiles, ['/run/keys'])
  assert.deepEqual(result.notes, [])
})

test('overrideFromCli: an empty --apiKey or --apiKeyFile is passed on, to be refused', () => {
  // Dropped, they would start the gateway without the key they meant to
  // require; passed on, they fail as they do without --config.
  assert.deepEqual(override(['--apiKey']).extraKeys, [''])
  assert.deepEqual(override(['--apiKey', '']).extraKeys, [''])
  assert.deepEqual(override(['--apiKeyFile']).extraKeyFiles, [''])
  assert.deepEqual(override(['--apiKeyFile=']).extraKeyFiles, [''])
})

// --- Printing a config ---

test('printableConfig: as a file would write it, with secrets redacted', () => {
  const config = loaded({
    port: 9000,
    healthEndpoint: '/healthz',
    apiKey: ['k1', 'k2'],
    oauth2Bearer: 'top-token',
    headers: { Authorization: 'Bearer x', 'x-team': 'core' },
    mcpServers: {
      local: {
        command: 'node',
        args: ['srv.js', '--verbose'],
        env: {
          API_TOKEN: 't',
          GITHUB_PERSONAL_ACCESS_TOKEN: 'g',
          DB_PASSWORD: 'p',
          DEBUG: '1',
          MONKEY: 'see',
        },
        cwd: '/srv',
        apiKeyFile: '/run/keys',
      },
      shell: {
        stdio: 'srv --flag',
        path: '/sh',
        apiKey: 'k3',
        outputTransport: 'ws',
      },
      remote: {
        url: 'http://h/mcp',
        type: 'http',
        oauth2Bearer: 'entry-token',
        headers: { 'x-api-key': 'a', 'x-trace': 'on' },
        outputTransport: 'sse',
      },
      both: {
        outputTransport: 'sse',
        mcpServers: {
          docs: {
            url: 'http://h/sse',
            type: 'sse',
            headers: { cookie: 'c', accept: 'json' },
            oauth2Bearer: 'inner-token',
          },
          files: { command: 'fs', env: { SESSION_ID: 's', ROOT: '/' } },
        },
      },
    },
  })
  assert.deepEqual(printableConfig(config), {
    port: 9000,
    healthEndpoint: ['/healthz'],
    apiKey: ['<redacted>', '<redacted>'],
    oauth2Bearer: '<redacted>',
    headers: { Authorization: '<redacted>', 'x-team': 'core' },
    mcpServers: {
      local: {
        command: 'node',
        args: ['srv.js', '--verbose'],
        env: {
          API_TOKEN: '<redacted>',
          GITHUB_PERSONAL_ACCESS_TOKEN: '<redacted>',
          DB_PASSWORD: '<redacted>',
          DEBUG: '1',
          MONKEY: 'see',
        },
        cwd: '/srv',
        apiKeyFile: '/run/keys',
      },
      shell: {
        stdio: 'srv --flag',
        path: '/sh',
        outputTransport: 'ws',
        apiKey: ['<redacted>'],
      },
      remote: {
        type: 'streamableHttp',
        url: 'http://h/mcp',
        outputTransport: 'sse',
        headers: { 'x-api-key': '<redacted>', 'x-trace': 'on' },
        oauth2Bearer: '<redacted>',
      },
      both: {
        mcpServers: {
          docs: {
            type: 'sse',
            url: 'http://h/sse',
            headers: { cookie: '<redacted>', accept: 'json' },
            oauth2Bearer: '<redacted>',
          },
          files: {
            command: 'fs',
            args: [],
            env: { SESSION_ID: '<redacted>', ROOT: '/' },
          },
        },
        outputTransport: 'sse',
      },
    },
  })
})

test('printableConfig: a config without secrets reads back as itself', () => {
  for (const args of [
    [
      '--stdio',
      'srv --x',
      '--port',
      '9000',
      '--cors',
      '--healthEndpoint',
      '/h',
    ],
    [
      '--stdio',
      'srv',
      '--outputTransport',
      'streamableHttp',
      '--stateful',
      '--sessionTimeout',
      '250',
      '--header',
      'x-team: core',
      '--cors',
      'http://a.example',
    ],
    ['--sse', 'http://h/sse', '--header', 'x-trace: on', '--logLevel', 'none'],
  ]) {
    const config = fromCli(args)
    assert.deepEqual(loaded(printableConfig(config)), config, args.join(' '))
  }
})

// --- The command line an entry runs as ---

const entryOf = (config: Config, name = 'a') =>
  config.entries.find((entry) => entry.name === name) as Entry

const run = (
  value: Record<string, unknown>,
  extraKeys: string[] = [],
  extraKeyFiles: string[] = [],
) => {
  const config = loaded(value)
  return cliForEntry(config, entryOf(config), extraKeys, extraKeyFiles)
}

test('cliForEntry: a command entry runs without a shell, under its path', () => {
  const result = run({
    mcpServers: { a: { command: 'node', args: ['srv.js', 'a b'] } },
  })
  assert.deepEqual(result, {
    args: [
      '--stdio=node',
      '--ssePath=/a/sse',
      '--messagePath=/a/message',
      '--streamableHttpPath=/a/mcp',
    ],
    command: {
      command: 'node',
      args: ['srv.js', 'a b'],
      env: undefined,
      cwd: undefined,
    },
  })
  const argv = parseCli(result.args)
  assert.equal(argv.outputTransport, 'sse', 'the CLI default, as for --stdio')
  assert.equal(argv.ssePath, '/a/sse')
})

test('cliForEntry: a stdio entry is the --stdio string, unless it sets env or cwd', () => {
  assert.deepEqual(
    run({ mcpServers: { a: { stdio: 'srv --x' } } }).command,
    'srv --x',
  )
  assert.deepEqual(
    run({ mcpServers: { a: { stdio: 'srv', env: { A: '1' } } } }).command,
    { stdio: 'srv', env: { A: '1' }, cwd: undefined },
  )
  assert.deepEqual(
    run({ mcpServers: { a: { stdio: 'srv', cwd: '/srv' } } }).command,
    { stdio: 'srv', env: undefined, cwd: '/srv' },
  )
  assert.equal(
    run({ mcpServers: { a: { stdio: 'srv --x' } } }).args[0],
    '--stdio=srv --x',
  )
})

test('cliForEntry: a remote entry is --sse or --streamableHttp, with no command', () => {
  assert.deepEqual(
    run({ mcpServers: { a: { url: 'http://h/sse', type: 'sse' } } }),
    {
      args: [
        '--sse=http://h/sse',
        '--ssePath=/a/sse',
        '--messagePath=/a/message',
        '--streamableHttpPath=/a/mcp',
      ],
      command: undefined,
    },
  )
  assert.equal(
    run({ mcpServers: { a: { url: 'http://h/mcp', type: 'http' } } }).args[0],
    '--streamableHttp=http://h/mcp',
  )
})

test('cliForEntry: at "/", paths are the CLI\'s own, and set ones are kept as set', () => {
  assert.deepEqual(
    run({ mcpServers: { a: { command: 'srv', path: '/' } } }).args,
    ['--stdio=srv'],
  )
  assert.deepEqual(
    run({
      mcpServers: {
        a: {
          command: 'srv',
          path: '/',
          ssePath: '/events',
          healthEndpoint: '/live',
        },
      },
    }).args,
    ['--stdio=srv', '--ssePath=/events', '--healthEndpoint=/live'],
  )
  assert.deepEqual(
    run({
      mcpServers: { a: { command: 'srv', path: '/', healthEndpoint: '/' } },
    }).args,
    ['--stdio=srv', '--healthEndpoint=/'],
  )
})

test('cliForEntry: an entry\'s health endpoint "/" is its own path', () => {
  assert.deepEqual(
    run({
      mcpServers: { a: { command: 'srv', healthEndpoint: ['/', '/live'] } },
    }).args.filter((arg) => arg.startsWith('--healthEndpoint')),
    ['--healthEndpoint=/a', '--healthEndpoint=/a/live'],
  )
})

test("cliForEntry: set paths and health endpoints go under the entry's path", () => {
  assert.deepEqual(
    run({
      healthEndpoint: ['/healthz'],
      ssePath: '/events',
      mcpServers: {
        a: {
          command: 'srv',
          path: '/tools/v1',
          messagePath: '/msgs',
          streamableHttpPath: '/rpc',
          healthEndpoint: ['/live', '/ready'],
        },
      },
    }).args,
    [
      '--stdio=srv',
      '--ssePath=/tools/v1/events',
      '--messagePath=/tools/v1/msgs',
      '--streamableHttpPath=/tools/v1/rpc',
      '--healthEndpoint=/healthz',
      '--healthEndpoint=/tools/v1/live',
      '--healthEndpoint=/tools/v1/ready',
    ],
  )
})

test("cliForEntry: every setting, the entry's own over the file's defaults", () => {
  const result = run(
    {
      port: 9000,
      host: '127.0.0.1',
      logLevel: 'debug',
      logFormat: 'json',
      exitWithProcess: 4242,
      outputTransport: 'ws',
      baseUrl: 'http://default',
      cors: ['http://a.example', '/b$/'],
      headers: { 'x-default': '1' },
      oauth2Bearer: 'default-token',
      apiKey: ['default-key'],
      apiKeyFile: '/run/default',
      stateful: true,
      sessionTimeout: 1000,
      protocolVersion: '2025-03-26',
      mcpServers: {
        a: {
          command: 'srv',
          path: '/',
          outputTransport: 'streamableHttp',
          headers: { 'x-team': 'core', Authorization: 'Bearer t' },
          apiKey: 'entry-key',
          stateful: false,
          sessionTimeout: 250,
        },
      },
    },
    ['cli-key'],
    ['/run/cli'],
  )
  assert.deepEqual(result.args, [
    '--stdio=srv',
    '--port=9000',
    '--host=127.0.0.1',
    '--logLevel=debug',
    '--logFormat=json',
    '--exitWithProcess=4242',
    '--outputTransport=streamableHttp',
    '--baseUrl=http://default',
    '--cors=http://a.example',
    '--cors=/b$/',
    '--header=x-team: core',
    '--header=Authorization: Bearer t',
    '--oauth2Bearer=default-token',
    '--apiKey=entry-key',
    '--apiKey=cli-key',
    '--apiKeyFile=/run/default',
    '--apiKeyFile=/run/cli',
    '--sessionTimeout=250',
    '--protocolVersion=2025-03-26',
  ])
  // And the CLI reads them back as meant.
  const argv = parseCli(result.args)
  assert.deepEqual(argv.header, ['x-team: core', 'Authorization: Bearer t'])
  assert.deepEqual(argv.cors, ['http://a.example', '/b$/'])
  assert.deepEqual(argv.apiKey, ['entry-key', 'cli-key'])
  assert.deepEqual(argv.apiKeyFile, ['/run/default', '/run/cli'])
  assert.equal(argv.stateful, false)
})

test('cliForEntry: "cors": true and "stateful": true are bare flags', () => {
  assert.deepEqual(
    run({
      cors: true,
      stateful: true,
      mcpServers: { a: { command: 'srv', path: '/' } },
    }).args,
    ['--stdio=srv', '--cors', '--stateful'],
  )
  const argv = parseCli(
    run({
      cors: true,
      stateful: true,
      mcpServers: { a: { command: 'srv', path: '/' } },
    }).args,
  )
  assert.deepEqual(argv.cors, [])
  assert.equal(argv.stateful, true)
})

test("cliForEntry: an entry's tool settings are its flags, an empty list a bare --tools", () => {
  const tools = (value: Record<string, unknown>) =>
    run({ mcpServers: { a: { stdio: 'srv', ...value } } }).args.filter((arg) =>
      arg.startsWith('--tool'),
    )
  assert.deepEqual(tools({ toolPrefix: 'gh_', tools: ['search', 'get'] }), [
    '--toolPrefix=gh_',
    '--tools=search',
    '--tools=get',
  ])
  assert.deepEqual(tools({ tools: [] }), ['--tools'])
  assert.deepEqual(tools({}), [])
  // And they mean, read back, what they said.
  const argv = parseCli(
    run({ mcpServers: { a: { stdio: 'srv', tools: [] } } }).args,
  )
  assert.deepEqual(argv.tools, [])
})

test('cliForEntry: an empty key from beside --config is still passed', () => {
  const result = run(
    { mcpServers: { a: { command: 'srv', path: '/' } } },
    [''],
    [''],
  )
  assert.deepEqual(result.args, ['--stdio=srv', '--apiKey=', '--apiKeyFile='])
  const argv = parseCli(result.args)
  assert.deepEqual(argv.apiKey, [''])
  assert.equal(argv.apiKeyFile, '')
})

test('cliForEntry: a combined entry has no command line', () => {
  const config = loaded({
    mcpServers: { a: { mcpServers: { b: { command: 'x' } } } },
  })
  assert.throws(() => cliForEntry(config, entryOf(config), [], []), {
    message: 'A combined entry has no command line equivalent',
  })
})

// --- Starting a child ---

type Spawn = Parameters<typeof spawnCommand>[0]

const recordingSpawn = () => {
  const calls: unknown[][] = []
  const child = { pid: 1 }
  const spawn = ((...args: unknown[]) => {
    calls.push(args)
    return child
  }) as unknown as Spawn
  return { calls, child, spawn }
}

test('spawnCommand: a string is spawned exactly as --stdio always was', () => {
  const { calls, child, spawn } = recordingSpawn()
  const options = { shell: true, detached: true }
  assert.equal(spawnCommand(spawn, 'npx -y pkg "a b"', options), child)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].length, 2)
  assert.equal(calls[0][0], 'npx -y pkg "a b"')
  assert.equal(calls[0][1], options, 'the options object itself, untouched')
})

test('spawnCommand: "stdio" runs in the shell, with env and cwd when given', () => {
  const { calls, spawn } = recordingSpawn()
  spawnCommand(spawn, { stdio: 'srv $HOME' }, { shell: true, detached: false })
  spawnCommand(
    spawn,
    { stdio: 'srv', env: { HOME: '/elsewhere', EXTRA: '1' }, cwd: '/srv' },
    { shell: true, detached: true },
  )
  assert.deepEqual(calls, [
    ['srv $HOME', { shell: true, detached: false }],
    [
      'srv',
      {
        shell: true,
        detached: true,
        env: { ...process.env, HOME: '/elsewhere', EXTRA: '1' },
        cwd: '/srv',
      },
    ],
  ])
})

test('spawnCommand: "command" and "args" run without a shell', () => {
  const { calls, spawn } = recordingSpawn()
  spawnCommand(
    spawn,
    { command: 'node', args: ['srv.js', 'a b', '$HOME'] },
    { shell: true, detached: true },
  )
  spawnCommand(
    spawn,
    { command: 'node', args: [], env: { EXTRA: '1' }, cwd: '/srv' },
    { shell: true, detached: false },
  )
  assert.deepEqual(calls, [
    ['node', ['srv.js', 'a b', '$HOME'], { shell: false, detached: true }],
    [
      'node',
      [],
      {
        shell: false,
        detached: false,
        env: { ...process.env, EXTRA: '1' },
        cwd: '/srv',
      },
    ],
  ])
})

test('describeCommand: the command as the startup log shows it', () => {
  assert.equal(describeCommand('npx -y pkg'), 'npx -y pkg')
  assert.equal(describeCommand({ stdio: 'srv --x', cwd: '/srv' }), 'srv --x')
  assert.equal(
    describeCommand({ command: 'node', args: ['srv.js', '--port', '1'] }),
    'node srv.js --port 1',
  )
})

// --- Keys from a file and from the command line ---

test("apiKeysOf: --apiKeyFile may be repeated, a config file's and the flag's", () => {
  const files: Record<string, string> = { '/a': 'k1\n', '/b': 'k2\nk1\n' }
  assert.deepEqual(
    apiKeysOf(
      { apiKeyFile: ['/a', '/b'], outputTransport: 'sse' },
      {},
      (path) => files[path],
    ),
    { keys: ['k1', 'k2'] },
  )
  assert.deepEqual(
    apiKeysOf(
      { apiKeyFile: ['/a', ''], outputTransport: 'sse' },
      {},
      (path) => files[path],
    ),
    {
      error:
        'Error: --apiKeyFile is set but empty; give it a value or leave it out',
    },
  )
})
