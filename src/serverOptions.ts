import { type Cli, sessionTimeoutOf } from './cli.js'
import type { ChildCommand } from './lib/childCommand.js'
import type { Logger } from './types.js'
import type { ServerSource } from './lib/serverSource.js'
import type { MemberServer } from './config/cliConfig.js'
import { parseUpstreamUrl } from './lib/urlCredentials.js'
import { headers } from './lib/headers.js'
import { ToolNames } from './lib/toolNames.js'
import { corsOrigin } from './lib/corsOrigin.js'
import type { HealthCheck } from './lib/serverHealth.js'
import { orExit } from './exits.js'
import type { Mount } from './lib/serve.js'
import { stdioToSseMount } from './gateways/stdioToSse.js'
import { stdioToWsMount } from './gateways/stdioToWs.js'
import { stdioToStatefulStreamableHttpMount } from './gateways/stdioToStatefulStreamableHttp.js'
import { stdioToStatelessStreamableHttpMount } from './gateways/stdioToStatelessStreamableHttp.js'

// What a listening gateway takes beyond the command line, once checked:
// `host` is the address `--host` names, or undefined for every interface, and
// `apiKeys` is empty when no source gives a key, so authentication is off.
export type Listening = { host: string | undefined; apiKeys: string[] }

// A config file can start a server without a shell (`command` + `args`), or
// with its own environment and directory; it puts that here in place of the
// `--stdio` string. See cliForEntry.
const stdioCommand = (argv: Cli) => argv.stdio! as ChildCommand

// What a stdio server's gateway takes beyond the port, in either form: alone
// on the port, or mounted at `path` beside others.
type ServerOptions = Listening & { path?: string }

// The server a listening gateway serves: the --stdio command, or the --sse
// or --streamableHttp server, with --header and --oauth2Bearer as what the
// gateway sends it.
export const serverOf = (argv: Cli, logger: Logger): ServerSource => {
  const url = argv.sse ?? argv.streamableHttp
  const toolNames = toolNamesOf(argv, logger)
  // A combined entry's servers, which no command line can name.
  const members = argv.combined as MemberServer[] | undefined
  if (members)
    return {
      combined: {
        name: argv.stdio!,
        members: members.map((member) => memberSource(member, logger)),
        warned: new Set(),
      },
      toolNames,
    }
  if (url === undefined) return { stdioCmd: stdioCommand(argv), toolNames }
  return {
    upstream: {
      url: parseUpstreamUrl(url),
      type: argv.sse ? 'sse' : 'streamableHttp',
      headers: headers({ argv, logger }),
    },
    toolNames,
  }
}

// One of a combined entry's servers: local or remote, with its own tools.
const memberSource = (
  { name, command, upstream, toolPrefix, tools }: MemberServer,
  logger: Logger,
): ServerSource & { name: string } => {
  const toolNames = ToolNames.of({ toolPrefix, tools }, logger)
  return upstream
    ? {
        name,
        upstream: { ...upstream, url: parseUpstreamUrl(upstream.url) },
        toolNames,
      }
    : // The loader gives a server a command or a url.
      { name, stdioCmd: command!, toolNames }
}

// The tools a client sees of the server: none rewritten unless --toolPrefix
// or --tools is given.
export const toolNamesOf = (argv: Cli, logger: Logger) =>
  ToolNames.of(
    { toolPrefix: argv.toolPrefix, tools: argv.tools as string[] | undefined },
    logger,
  )

// What the gateway's own responses carry: --header for a local server. For a
// remote one, --header is what the gateway sends it; returning that to every
// client could hand them the remote server's credentials.
const responseHeaders = (source: ServerSource, argv: Cli, logger: Logger) =>
  source.upstream ? {} : headers({ argv, logger })

// What every listening gateway takes, whichever output it serves. `source`
// is kept apart, so a gateway that answers with headers can tell whether its
// server is remote.
const listenerArgs = (
  argv: Cli,
  logger: Logger,
  { host, apiKeys, path }: ServerOptions,
) => {
  const source = serverOf(argv, logger)
  return {
    source,
    shared: {
      ...source,
      host,
      path,
      logger,
      corsOrigin: corsOrigin({ argv }),
      healthEndpoints: argv.healthEndpoint as string[],
      healthCheck: argv.healthCheck as HealthCheck,
      apiKeys,
    },
  }
}

export const sseArgs = (argv: Cli, logger: Logger, options: ServerOptions) => {
  const { source, shared } = listenerArgs(argv, logger, options)
  return {
    ...shared,
    baseUrl: argv.baseUrl,
    ssePath: argv.ssePath,
    messagePath: argv.messagePath,
    headers: responseHeaders(source, argv, logger),
  }
}

export const wsArgs = (argv: Cli, logger: Logger, options: ServerOptions) => ({
  ...listenerArgs(argv, logger, options).shared,
  messagePath: argv.messagePath,
})

// Announces the mode and checks the timeout before building the arguments,
// so header diagnostics keep their place in the log.
export const streamableHttpArgs = (
  argv: Cli,
  logger: Logger,
  options: ServerOptions,
) => {
  const common = () => {
    const { source, shared } = listenerArgs(argv, logger, options)
    return {
      ...shared,
      streamableHttpPath: argv.streamableHttpPath,
      headers: responseHeaders(source, argv, logger),
    }
  }
  if (!argv.stateful) {
    logger.info('Running stateless server')
    return {
      stateful: false as const,
      args: { ...common(), protocolVersion: argv.protocolVersion },
    }
  }
  logger.info('Running stateful server')
  const { sessionTimeout } = orExit(logger, sessionTimeoutOf(argv))
  return {
    stateful: true as const,
    args: { ...common(), sessionTimeout },
  }
}

/** A stdio server mounted at its path, to share the port with others. */
export function mountOf(
  argv: Cli,
  logger: Logger,
  options: ServerOptions,
): Mount {
  if (argv.outputTransport === 'sse')
    return stdioToSseMount(sseArgs(argv, logger, options))
  if (argv.outputTransport === 'ws')
    return stdioToWsMount(wsArgs(argv, logger, options))
  // The loader gives every entry here a listening output.
  const { stateful, args } = streamableHttpArgs(argv, logger, options)
  return stateful
    ? stdioToStatefulStreamableHttpMount(args)
    : stdioToStatelessStreamableHttpMount(args)
}
