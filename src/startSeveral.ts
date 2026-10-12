import type { KeyedServer } from './invocation.js'
import type { Logger } from './types.js'
import { onStdio } from './startOne.js'
import { serve } from './lib/serve.js'
import { mountOf } from './serverOptions.js'
import type { BridgeLifecycle } from './lib/stdioBridge.js'
import { orExit } from './exits.js'
import { inputTransportOf, type Cli } from './cli.js'
import { requestShutdown } from './lib/onSignals.js'

// Several config entries, each mounted at its path, on one port, and at most
// one on stdio beside them (the loader allows no more).
export async function serveSeveral(
  servers: KeyedServer[],
  healthEndpoints: string[],
  port: number,
  host: string | undefined,
  logger: Logger,
) {
  const onStdio = servers.find(isOnStdio)
  let closeStdio: (() => Promise<void>) | undefined
  serve({
    port,
    host,
    logger,
    mounts: servers
      .filter((server) => server !== onStdio)
      .map((server) => {
        server.logger.info(`  - path: ${server.path}`)
        server.logger.info(
          `  - outputTransport: ${server.argv.outputTransport}`,
        )
        return mountOf(server.argv, server.logger, {
          host,
          apiKeys: server.apiKeys,
          path: server.path,
        })
      }),
    healthEndpoints,
    stdio: onStdio && { close: async () => closeStdio?.() },
  })
  if (onStdio)
    await bridgeBeside(onStdio, (cleanup) => {
      closeStdio = cleanup
    })
}

export const isOnStdio = (server: { argv: Cli }) =>
  server.argv.outputTransport === 'stdio'

// The entry on stdio beside the others. The process is its client's,
// which started it: when the bridge stops, the others stop too, as at a
// signal, and the signals stop the bridge with them.
async function bridgeBeside(
  server: KeyedServer,
  register: BridgeLifecycle['register'],
) {
  server.logger.info('  - outputTransport: stdio')
  const { input } = orExit(server.logger, inputTransportOf(server.argv))
  await onStdio(input, server.argv, server.logger, {
    register,
    exit: (code) =>
      requestShutdown(`${server.name} on stdio stopped. Exiting...`, code),
  })
}
