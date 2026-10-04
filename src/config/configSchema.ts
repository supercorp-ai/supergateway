import { CONFIG_KEYS } from './configFile.js'

/**
 * The JSON Schema of a `--config` file, for editors: completion, hover text
 * and a red line under a mistyped key. It ships as `config.schema.json`.
 *
 * It is generated from the loader's own key tables, so a key the loader
 * takes and the schema doesn't know (or the other way) fails here, and in
 * the test that compares this with the shipped file. The loader stays the
 * judge of a file: a schema can't say "one of command, stdio or url", or
 * that two servers want the same path.
 */

type Schema = Record<string, unknown>

const text = (description: string): Schema => ({
  type: 'string',
  pattern: '\\S',
  description,
})
const whole = (minimum: number, description: string): Schema => ({
  type: 'integer',
  minimum,
  description,
})
const flag = (description: string): Schema => ({ type: 'boolean', description })
const oneOf = (values: string[], description: string): Schema => ({
  enum: values,
  description,
})
const stringMap = (description: string): Schema => ({
  type: 'object',
  additionalProperties: { type: 'string' },
  description,
})

// Every key the loader takes, at whichever level it takes it.
const PROPERTIES: Record<string, Schema> = {
  $schema: { type: 'string', description: 'This schema, for editors.' },

  // The gateway's own.
  port: whole(0, 'The port to listen on. Default: 8000.'),
  host: text('The address to listen on. Default: every interface.'),
  logLevel: oneOf(['debug', 'info', 'none'], 'Default: info.'),
  logFormat: oneOf(
    ['text', 'json'],
    'Log lines as text (default) or one JSON object per line.',
  ),
  exitWithProcess: whole(2, 'Shut down when the process with this PID exits.'),
  healthEndpoint: {
    oneOf: [
      { type: 'string', pattern: '\\S' },
      { type: 'array', items: { type: 'string', pattern: '\\S' } },
    ],
    description:
      'Paths that answer "ok". At the top level they are the gateway\'s own; on a server they are under its path.',
  },

  // How a server is served; at the top level, the default for every server.
  outputTransport: oneOf(
    CONFIG_KEYS.transports,
    'How the server is served. Default: sse for a local server, stdio for a url one.',
  ),
  baseUrl: text('The public base URL clients reach an SSE server at.'),
  ssePath: text('Path of the SSE stream. Default: /sse.'),
  messagePath: text('Path for SSE and WebSocket messages. Default: /message.'),
  streamableHttpPath: text('Path for Streamable HTTP. Default: /mcp.'),
  cors: {
    oneOf: [
      { type: 'boolean' },
      { type: 'array', items: { type: 'string', pattern: '\\S' } },
    ],
    description:
      'true allows every origin; a list allows those origins ("/regex/" for a pattern).',
  },
  healthCheck: oneOf(
    ['gateway', 'server'],
    'What the health endpoints check: the gateway alone (default), or the MCP server too.',
  ),
  toolPrefix: text(
    'Put before every tool name the server lists, e.g. "github_".',
  ),
  tools: {
    type: 'array',
    items: { type: 'string', pattern: '\\S' },
    description:
      "Expose only these tools, by the server's own names. An empty list exposes none.",
  },
  apiKey: {
    oneOf: [
      { type: 'string', pattern: '\\S' },
      { type: 'array', items: { type: 'string', pattern: '\\S' } },
    ],
    description:
      'Keys a client must present, as Authorization: Bearer <key> or X-API-Key.',
  },
  apiKeyFile: text('A file of accepted keys, one per line.'),
  stateful: flag('Serve Streamable HTTP with sessions.'),
  sessionTimeout: whole(1, 'Milliseconds an idle stateful session is kept.'),
  protocolVersion: text(
    'The protocol version the gateway initializes a server with, in stateless Streamable HTTP, when the client names none.',
  ),
  headers: stringMap(
    "For a local server, headers on the gateway's responses; for a url server, headers sent to it.",
  ),
  oauth2Bearer: text('Sent as Authorization: Bearer <token>.'),

  // What a server is.
  command: text('The program to run, without a shell. Goes with "args".'),
  args: {
    type: 'array',
    items: { type: 'string' },
    description: 'Arguments of "command".',
  },
  stdio: text('A shell command line that runs the server, as --stdio.'),
  url: {
    type: 'string',
    pattern: '^https?://',
    description: 'A remote server. Goes with "type".',
  },
  type: oneOf(
    ['stdio', ...CONFIG_KEYS.urlTypes],
    'How to reach a url server: "sse" or "http" (Streamable HTTP). "stdio" for a local one, or nothing.',
  ),
  transportType: oneOf(
    ['stdio', ...CONFIG_KEYS.urlTypes],
    'The same as "type", as some clients write it.',
  ),
  env: stringMap("Added to the server's environment."),
  cwd: text("The server's working directory."),
  disabled: flag('true skips this server.'),
  enabled: flag('false skips this server.'),

  // An entry's own.
  path: text('Where the server is served. Default: /<name>.'),
}

// Other clients' keys: allowed, so a shared file has no red lines.
const clientOnly = Object.fromEntries(
  CONFIG_KEYS.clientOnly.map((key) => [
    key,
    { description: 'Used by other MCP clients. Supergateway ignores it.' },
  ]),
)

// The properties of one level: its keys, each as PROPERTIES has it.
const level = (keys: string[], extra: Record<string, Schema> = {}): Schema => ({
  type: 'object',
  properties: {
    ...Object.fromEntries(
      keys
        .filter((key) => !(key in extra))
        .map((key) => {
          if (!(key in PROPERTIES))
            throw new Error(`config.schema.json has no definition for "${key}"`)
          return [key, PROPERTIES[key]]
        }),
    ),
    ...extra,
    ...clientOnly,
  },
  additionalProperties: false,
})

/** The schema, as `config.schema.json` holds it. */
export function configSchema(): Schema {
  const inner = level(CONFIG_KEYS.inner)
  const entry = level(CONFIG_KEYS.entry, {
    mcpServers: {
      type: 'object',
      additionalProperties: { $ref: '#/definitions/combinedServer' },
      description:
        'Servers combined as one on this URL. Combining goes one level deep.',
    },
  })
  const top = level(CONFIG_KEYS.top, {
    mcpServers: {
      type: 'object',
      additionalProperties: { $ref: '#/definitions/server' },
      description: 'The servers, by name. Each is served at /<name>.',
    },
  })
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://raw.githubusercontent.com/supercorp-ai/supergateway/main/config.schema.json',
    title: 'Supergateway config',
    description:
      'A --config file: servers under "mcpServers", as MCP clients write them, and any option of the command line.',
    ...top,
    required: ['mcpServers'],
    definitions: { server: entry, combinedServer: inner },
  }
}
