import type {
  JSONRPCMessage,
  JSONRPCRequest,
  JSONRPCResponse,
} from '@modelcontextprotocol/sdk/types.js'
import type { Logger } from '../types.js'
import type { StartPeer } from './childHandoff.js'

// What a tool name may be: 1 to 128 of these characters (MCP 2025-11-25).
const VALID_NAME = /^[A-Za-z0-9_.-]{1,128}$/
const INVALID_PARAMS = -32602

const isRequest = (message: JSONRPCMessage): message is JSONRPCRequest =>
  'method' in message && 'id' in message

const isResponse = (
  message: any,
): message is JSONRPCMessage & { id: string | number } =>
  'id' in message && !('method' in message)

type ToolsListResult = { tools?: unknown; [key: string]: unknown }

const nameOf = (tool: unknown) => {
  const name = (tool as { name?: unknown } | null)?.name
  return typeof name === 'string' ? name : undefined
}

/**
 * The tools a client sees of a server, as --toolPrefix and --tools set them:
 * each name with the prefix before it, and only the tools listed, if a list is
 * given. The only place the gateway rewrites what passes between a client and
 * its server, and only `tools/list` results and `tools/call` requests: every
 * other message passes as it is.
 */
export class ToolNames {
  // Names already warned about, so a list polled often warns once.
  private readonly warned = new Set<string>()

  private constructor(
    readonly prefix: string,
    readonly allowed: ReadonlySet<string> | undefined,
    private readonly logger: Logger,
  ) {}

  /** None when neither is set: then nothing is rewritten at all. */
  static of(
    { toolPrefix = '', tools }: { toolPrefix?: string; tools?: string[] },
    logger: Logger,
  ): ToolNames | undefined {
    if (toolPrefix === '' && tools === undefined) return undefined
    if (toolPrefix && !VALID_NAME.test(toolPrefix))
      logger.error(
        `toolPrefix "${toolPrefix}" makes tool names a client may refuse: a tool name is letters, digits, "_", "-" and "." only`,
      )
    return new ToolNames(
      toolPrefix,
      tools === undefined ? undefined : new Set(tools),
      logger,
    )
  }

  /** The startup listing's lines for these settings. */
  describe(): string[] {
    return [
      ...(this.prefix ? [`toolPrefix: ${this.prefix}`] : []),
      ...(this.allowed
        ? [`tools: ${[...this.allowed].join(', ') || '(none)'}`]
        : []),
    ]
  }

  /** The server's name for a tool the client named, if the client may call it. */
  private serverName(name: unknown): string | undefined {
    if (typeof name !== 'string' || !name.startsWith(this.prefix))
      return undefined
    const own = name.slice(this.prefix.length)
    return !this.allowed || this.allowed.has(own) ? own : undefined
  }

  /**
   * A message from the client, as the server is to get it; or, for a call to
   * a tool the client can't see, the error that answers it instead. The
   * error is the one the spec has a server give for a tool it doesn't have.
   */
  inbound(
    message: JSONRPCMessage,
  ): { forward: JSONRPCMessage } | { reply: JSONRPCResponse } {
    if (!isRequest(message) || message.method !== 'tools/call')
      return { forward: message }
    const name = message.params?.name
    const own = this.serverName(name)
    if (own === undefined)
      return {
        reply: {
          jsonrpc: '2.0',
          id: message.id,
          error: { code: INVALID_PARAMS, message: `Unknown tool: ${name}` },
        } as unknown as JSONRPCResponse,
      }
    return {
      forward: { ...message, params: { ...message.params, name: own } },
    }
  }

  /** A `tools/list` result, as the client is to see it. */
  listed<T extends ToolsListResult>(result: T): T {
    if (!Array.isArray(result.tools)) return result
    const tools = result.tools
      // A tool without a name is no tool the list allows.
      .filter((tool) => !this.allowed || this.allowed.has(nameOf(tool)!))
      .map((tool) => {
        if (nameOf(tool) === undefined) return tool
        const name = `${this.prefix}${nameOf(tool)}`
        this.warnIfInvalid(name)
        return { ...tool, name }
      })
    return { ...result, tools }
  }

  private warnIfInvalid(name: string) {
    if (!this.prefix || VALID_NAME.test(name) || this.warned.has(name)) return
    this.warned.add(name)
    this.logger.error(
      `Tool "${name}" is not a valid tool name (letters, digits, "_", "-" and ".", at most 128); a client may refuse it`,
    )
  }
}

/**
 * A server whose tools a client sees through `names`. It answers a call to a
 * tool the client can't see itself, and rewrites the results of the
 * `tools/list` requests it was sent.
 */
export const toolNamesPeer =
  (start: StartPeer, names: ToolNames): StartPeer =>
  (owner) => {
    // The ids of the tools/list requests the server has yet to answer.
    const lists = new Set<string | number>()
    const peer = start({
      ...owner,
      message: (message, line) => {
        // An answer to one of them; an error passes as it is.
        const listed = isResponse(message) && lists.delete(message.id)
        if (!listed || !('result' in message)) {
          owner.message(message, line)
          return
        }
        const rewritten = { ...message, result: names.listed(message.result) }
        owner.message(rewritten, JSON.stringify(rewritten))
      },
    })
    return {
      write: (message) => {
        const sent = names.inbound(message)
        if ('reply' in sent) {
          // As the server's own answer would: later, never inside write.
          queueMicrotask(() =>
            owner.message(sent.reply, JSON.stringify(sent.reply)),
          )
          return
        }
        if (isRequest(message) && message.method === 'tools/list')
          lists.add(message.id)
        peer.write(sent.forward)
      },
      end: () => peer.end(),
      stop: () => peer.stop(),
      get gone() {
        return peer.gone
      },
    }
  }
