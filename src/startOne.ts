import type { Cli, InputTransport } from './cli.js'
import type { Logger } from './types.js'
import {
  type Listening,
  sseArgs,
  wsArgs,
  streamableHttpArgs,
  toolNamesOf,
  serverOf,
} from './serverOptions.js'
import { stdioToSse } from './gateways/stdioToSse.js'
import { stdioToWs } from './gateways/stdioToWs.js'
import { stdioToStatefulStreamableHttp } from './gateways/stdioToStatefulStreamableHttp.js'
import { stdioToStatelessStreamableHttp } from './gateways/stdioToStatelessStreamableHttp.js'
import { exitWithError } from './exits.js'
import type { BridgeLifecycle } from './lib/stdioBridge.js'
import { sseToStdio } from './gateways/sseToStdio.js'
import { headers } from './lib/headers.js'
import { streamableHttpToStdio } from './gateways/streamableHttpToStdio.js'
import { combinedToStdio } from './gateways/combinedToStdio.js'

const unsupported = (logger: Logger, input: InputTransport, output: unknown) =>
  exitWithError(logger, `Error: ${input}→${output} not supported`)

// A server served over HTTP or WebSocket, alone on the port. The command
// line only allows the four outputs, and stdio is a bridge or refused.
const listen = async (argv: Cli, logger: Logger, listening: Listening) => {
  const { port } = argv
  if (argv.outputTransport === 'sse')
    await stdioToSse({ ...sseArgs(argv, logger, listening), port })
  else if (argv.outputTransport === 'ws')
    await stdioToWs({ ...wsArgs(argv, logger, listening), port })
  else {
    const { stateful, args } = streamableHttpArgs(argv, logger, listening)
    if (stateful) await stdioToStatefulStreamableHttp({ ...args, port })
    else await stdioToStatelessStreamableHttp({ ...args, port })
  }
}

// A remote server bridged to stdio output.
const bridge = {
  sse: (argv: Cli, logger: Logger, lifecycle?: BridgeLifecycle) =>
    sseToStdio({
      sseUrl: argv.sse!,
      logger,
      headers: headers({ argv, logger }),
      toolNames: toolNamesOf(argv, logger),
      lifecycle,
    }),
  streamableHttp: (argv: Cli, logger: Logger, lifecycle?: BridgeLifecycle) =>
    streamableHttpToStdio({
      streamableHttpUrl: argv.streamableHttp!,
      logger,
      headers: headers({ argv, logger }),
      toolNames: toolNamesOf(argv, logger),
      lifecycle,
    }),
}

// How a server alone on the port starts, given the output the command line
// chose. A remote server on stdio is a bridge; on any other output, it is
// served the way a local one is. A local server already speaks stdio.
export async function start(
  input: InputTransport,
  argv: Cli,
  logger: Logger,
  listening: Listening,
) {
  if (argv.outputTransport !== 'stdio') await listen(argv, logger, listening)
  else if (input === 'stdio' && !argv.combined)
    unsupported(logger, input, argv.outputTransport)
  else await onStdio(input, argv, logger)
}

// A server on stdio output: servers combined as one, or a remote one bridged.
// The loader and the check above allow no other.
export const onStdio = async (
  input: InputTransport,
  argv: Cli,
  logger: Logger,
  lifecycle?: BridgeLifecycle,
) => {
  if (argv.combined)
    combinedToStdio({ ...serverOf(argv, logger), logger, lifecycle })
  else await bridge[input as keyof typeof bridge](argv, logger, lifecycle)
}
