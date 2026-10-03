// The server the MCP conformance suite expects
// (`npx @modelcontextprotocol/conformance server --url …`): its `test_*`
// tools, prompts and resources, written from each scenario's own "Server
// Implementation Requirements". Plain JSON-RPC over stdio, so a gateway can
// be checked with it alone and combined with other servers.
//
// With argv[2] = "half-a" or "half-b" it offers one half of everything (tools
// and prompts in a, resources in b), so the two combined are the whole.

const half = process.argv[2]
const has = (part) => !half || half === `half-${part}`

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='
const WAV = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA='

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Requests this server makes of the client, by its own id.
let requests = 0
const waiting = new Map()
const ask = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++requests
    waiting.set(id, { resolve, reject })
    send({ jsonrpc: '2.0', id, method, params })
  })

const text = (value) => ({ content: [{ type: 'text', text: value }] })
const noArguments = { type: 'object', properties: {} }
const elicited = async (requestedSchema) => {
  const { action, content } = await ask('elicitation/create', {
    message: 'Please fill in the form',
    requestedSchema,
  })
  return text(
    `Elicitation completed: action=${action}, content=${JSON.stringify(content ?? {})}`,
  )
}

let clientCapabilities = {}

const tools = {
  test_simple_text: {
    description: 'Returns simple text',
    call: () => text('This is a simple text response for testing.'),
  },
  test_image_content: {
    description: 'Returns an image',
    call: () => ({
      content: [{ type: 'image', data: PNG, mimeType: 'image/png' }],
    }),
  },
  test_audio_content: {
    description: 'Returns audio',
    call: () => ({
      content: [{ type: 'audio', data: WAV, mimeType: 'audio/wav' }],
    }),
  },
  test_embedded_resource: {
    description: 'Returns an embedded resource',
    call: () => ({
      content: [
        {
          type: 'resource',
          resource: {
            uri: 'test://embedded-resource',
            mimeType: 'text/plain',
            text: 'This is an embedded resource content.',
          },
        },
      ],
    }),
  },
  test_multiple_content_types: {
    description: 'Returns several content types',
    call: () => ({
      content: [
        { type: 'text', text: 'Multiple content types test:' },
        { type: 'image', data: PNG, mimeType: 'image/png' },
        {
          type: 'resource',
          resource: {
            uri: 'test://mixed-content-resource',
            mimeType: 'application/json',
            text: '{"test":"data","value":123}',
          },
        },
      ],
    }),
  },
  test_tool_with_logging: {
    description: 'Logs while it runs',
    call: async () => {
      for (const data of [
        'Tool execution started',
        'Tool processing data',
        'Tool execution completed',
      ]) {
        send({
          jsonrpc: '2.0',
          method: 'notifications/message',
          params: { level: 'info', data },
        })
        await pause(50)
      }
      return text('Tool with logging executed')
    },
  },
  test_error_handling: {
    description: 'Always fails',
    call: () => ({
      isError: true,
      content: [
        {
          type: 'text',
          text: 'This tool intentionally returns an error for testing',
        },
      ],
    }),
  },
  test_tool_with_progress: {
    description: 'Reports progress',
    call: async (_args, meta) => {
      for (const progress of [0, 50, 100]) {
        if (meta?.progressToken !== undefined)
          send({
            jsonrpc: '2.0',
            method: 'notifications/progress',
            params: { progressToken: meta.progressToken, progress, total: 100 },
          })
        await pause(50)
      }
      return text('Tool with progress executed')
    },
  },
  test_sampling: {
    description: 'Samples the client',
    inputSchema: {
      type: 'object',
      properties: { prompt: { type: 'string' } },
      required: ['prompt'],
    },
    call: async ({ prompt }) => {
      if (!clientCapabilities.sampling)
        throw Error('The client does not support sampling')
      const result = await ask('sampling/createMessage', {
        messages: [{ role: 'user', content: { type: 'text', text: prompt } }],
        maxTokens: 100,
      })
      return text(`LLM response: ${result.content?.text}`)
    },
  },
  test_elicitation: {
    description: 'Asks the user',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
    call: async ({ message }) => {
      if (!clientCapabilities.elicitation)
        throw Error('The client does not support elicitation')
      const { action, content } = await ask('elicitation/create', {
        message,
        requestedSchema: {
          type: 'object',
          properties: {
            username: { type: 'string', description: "User's response" },
            email: { type: 'string', description: "User's email address" },
          },
          required: ['username', 'email'],
        },
      })
      return text(
        `User response: action: ${action}, content: ${JSON.stringify(content ?? {})}`,
      )
    },
  },
  test_elicitation_sep1034_defaults: {
    description: 'Asks with defaults',
    call: () =>
      elicited({
        type: 'object',
        properties: {
          name: { type: 'string', default: 'John Doe' },
          age: { type: 'integer', default: 30 },
          score: { type: 'number', default: 95.5 },
          status: {
            type: 'string',
            enum: ['active', 'inactive', 'pending'],
            default: 'active',
          },
          verified: { type: 'boolean', default: true },
        },
      }),
  },
  test_elicitation_sep1330_enums: {
    description: 'Asks with every enum form',
    call: () =>
      elicited({
        type: 'object',
        properties: {
          untitledSingle: {
            type: 'string',
            enum: ['option1', 'option2', 'option3'],
          },
          titledSingle: {
            type: 'string',
            oneOf: [
              { const: 'value1', title: 'First Option' },
              { const: 'value2', title: 'Second Option' },
              { const: 'value3', title: 'Third Option' },
            ],
          },
          legacyEnum: {
            type: 'string',
            enum: ['opt1', 'opt2', 'opt3'],
            enumNames: ['Option One', 'Option Two', 'Option Three'],
          },
          untitledMulti: {
            type: 'array',
            items: { type: 'string', enum: ['option1', 'option2', 'option3'] },
          },
          titledMulti: {
            type: 'array',
            items: {
              anyOf: [
                { const: 'value1', title: 'First Choice' },
                { const: 'value2', title: 'Second Choice' },
                { const: 'value3', title: 'Third Choice' },
              ],
            },
          },
        },
      }),
  },
  json_schema_2020_12_tool: {
    description: 'Tool with JSON Schema 2020-12 features',
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      $defs: {
        address: {
          type: 'object',
          properties: { street: { type: 'string' }, city: { type: 'string' } },
        },
      },
      properties: {
        name: { type: 'string' },
        address: { $ref: '#/$defs/address' },
      },
      additionalProperties: false,
    },
    call: () => text('ok'),
  },
}

const user = (content) => ({ role: 'user', content })
const prompts = {
  test_simple_prompt: {
    description: 'A simple prompt',
    get: () => ({
      messages: [
        user({ type: 'text', text: 'This is a simple prompt for testing.' }),
      ],
    }),
  },
  test_prompt_with_arguments: {
    description: 'A prompt with arguments',
    arguments: [
      { name: 'arg1', description: 'First test argument', required: true },
      { name: 'arg2', description: 'Second test argument', required: true },
    ],
    get: ({ arg1, arg2 }) => ({
      messages: [
        user({
          type: 'text',
          text: `Prompt with arguments: arg1='${arg1}', arg2='${arg2}'`,
        }),
      ],
    }),
  },
  test_prompt_with_embedded_resource: {
    description: 'A prompt with an embedded resource',
    arguments: [
      { name: 'resourceUri', description: 'The resource', required: true },
    ],
    get: ({ resourceUri }) => ({
      messages: [
        user({
          type: 'resource',
          resource: {
            uri: resourceUri,
            mimeType: 'text/plain',
            text: 'Embedded resource content for testing.',
          },
        }),
        user({
          type: 'text',
          text: 'Please process the embedded resource above.',
        }),
      ],
    }),
  },
  test_prompt_with_image: {
    description: 'A prompt with an image',
    get: () => ({
      messages: [
        user({ type: 'image', data: PNG, mimeType: 'image/png' }),
        user({ type: 'text', text: 'Please analyze the image above.' }),
      ],
    }),
  },
}

const resources = {
  'test://static-text': {
    name: 'Static text',
    description: 'A static text resource',
    mimeType: 'text/plain',
    text: 'This is the content of the static text resource.',
  },
  'test://static-binary': {
    name: 'Static binary',
    description: 'A static binary resource',
    mimeType: 'image/png',
    blob: PNG,
  },
  'test://watched-resource': {
    name: 'Watched',
    description: 'A resource to subscribe to',
    mimeType: 'text/plain',
    text: 'Watched resource content',
  },
}

const readResource = (uri) => {
  const listed = resources[uri]
  if (listed) {
    const { name: _name, description: _description, ...contents } = listed
    return { contents: [{ uri, ...contents }] }
  }
  const template = /^test:\/\/template\/([^/]+)\/data$/.exec(uri)
  if (!template) throw rpcError(-32002, 'Resource not found', { uri })
  const [, id] = template
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify({
          id,
          templateTest: true,
          data: `Data for ID: ${id}`,
        }),
      },
    ],
  }
}

const rpcError = (code, message, data) =>
  Object.assign(Error(message), { code, data })

const subscribed = new Set()
const methods = {
  initialize: ({ protocolVersion, capabilities }) => {
    clientCapabilities = capabilities ?? {}
    return {
      protocolVersion,
      capabilities: {
        ...(has('a') ? { tools: {}, prompts: {}, logging: {} } : {}),
        ...(has('b') ? { resources: { subscribe: true } } : {}),
        completions: {},
      },
      serverInfo: {
        name: `conformance-peer${half ? `-${half}` : ''}`,
        version: '1',
      },
    }
  },
  ping: () => ({}),
  'logging/setLevel': () => ({}),
  'tools/list': () => ({
    tools: Object.entries(tools).map(([name, tool]) => ({
      name,
      description: tool.description,
      inputSchema: tool.inputSchema ?? noArguments,
    })),
  }),
  'tools/call': async ({ name, arguments: args = {}, _meta }) => {
    const tool = tools[name]
    if (!tool) throw rpcError(-32602, `Unknown tool: ${name}`)
    try {
      return await tool.call(args, _meta)
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err.message }] }
    }
  },
  'prompts/list': () => ({
    prompts: Object.entries(prompts).map(([name, prompt]) => ({
      name,
      description: prompt.description,
      ...(prompt.arguments ? { arguments: prompt.arguments } : {}),
    })),
  }),
  'prompts/get': ({ name, arguments: args = {} }) => {
    const prompt = prompts[name]
    if (!prompt) throw rpcError(-32602, `Unknown prompt: ${name}`)
    return prompt.get(args)
  },
  'resources/list': () => ({
    resources: Object.entries(resources).map(
      ([uri, { name, description, mimeType }]) => ({
        uri,
        name,
        description,
        mimeType,
      }),
    ),
  }),
  'resources/templates/list': () => ({
    resourceTemplates: [
      {
        uriTemplate: 'test://template/{id}/data',
        name: 'Template',
        description: 'A resource template',
        mimeType: 'application/json',
      },
    ],
  }),
  'resources/read': ({ uri }) => readResource(uri),
  'resources/subscribe': ({ uri }) => {
    subscribed.add(uri)
    return {}
  },
  'resources/unsubscribe': ({ uri }) => {
    subscribed.delete(uri)
    return {}
  },
  'completion/complete': () => ({
    completion: {
      values: ['paris', 'park', 'party'],
      total: 3,
      hasMore: false,
    },
  }),
}
// What each half leaves to the other.
const ofA = [
  'tools/list',
  'tools/call',
  'prompts/list',
  'prompts/get',
  'logging/setLevel',
]
const ofB = [
  'resources/list',
  'resources/templates/list',
  'resources/read',
  'resources/subscribe',
  'resources/unsubscribe',
]
for (const method of has('a') ? [] : ofA) delete methods[method]
for (const method of has('b') ? [] : ofB) delete methods[method]

const handle = async ({ id, method, params = {} }) => {
  const handler = methods[method]
  try {
    if (!handler) throw rpcError(-32601, `Method not found: ${method}`)
    send({ jsonrpc: '2.0', id, result: await handler(params) })
  } catch ({ code = -32603, message, data }) {
    send({
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    })
  }
}

// MCP stdio is LF-delimited; readline would also split U+2028 inside JSON.
process.stdin.setEncoding('utf8')
let buffered = ''
process.stdin.on('data', (chunk) => {
  buffered += chunk
  let end
  while ((end = buffered.indexOf('\n')) !== -1) {
    const line = buffered.slice(0, end)
    buffered = buffered.slice(end + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.method === undefined) {
      // The client's answer to one of this server's requests.
      const asked = waiting.get(message.id)
      waiting.delete(message.id)
      if (message.error) asked?.reject(Error(message.error.message))
      else asked?.resolve(message.result)
    } else if (message.id !== undefined) void handle(message)
  }
})
