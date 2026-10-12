import { cli } from './cliOptions.js'
import { normalizeHost } from './lib/listenHost.js'
export { givenOptions, unknownArguments } from './cliArguments.js'

export type InputTransport = 'stdio' | 'sse' | 'streamableHttp'

// Idle lifetime of a stateful session when the flag is absent. See
// sessionTimeoutOf for why "never" was the wrong default.
export const defaultSessionTimeout = 30 * 60 * 1000

/** The command line, as every gateway reads it. */
export function parseCli(args: string[]) {
  const argv = cli(args).parseSync()
  argv.outputTransport ??= defaultOutputTransport(argv)
  return argv
}

/**
 * The output transport when none is named: SSE for a local server, stdio for
 * a remote one.
 *
 * Decided from what was parsed. It used to look for the literal argument
 * `--stdio`, `--sse` or `--streamableHttp`, so the same flag spelled
 * `--stdio=cmd` or `--streamable-http url`, both of which yargs accepts, left
 * the output transport undefined and the gateway refused to start
 * ("stdio→undefined not supported").
 */
const defaultOutputTransport = (argv: {
  stdio?: string
  sse?: string
  streamableHttp?: string
}) => {
  if (argv.stdio !== undefined) return 'sse'
  if (argv.sse !== undefined || argv.streamableHttp !== undefined)
    return 'stdio'
}

export type Cli = ReturnType<typeof parseCli>

/**
 * The one input transport the command line names, or why there is not one.
 *
 * One value rather than three booleans, so the compiler knows the cases are
 * mutually exclusive and can check that every one is handled. Three
 * independent flags cannot express that, which is why the old dispatch needed
 * a runtime `else` nothing could ever reach.
 */
export function inputTransportOf(
  argv: Cli,
): { input: InputTransport } | { error: string } {
  const inputs: InputTransport[] = []
  if (argv.stdio) inputs.push('stdio')
  if (argv.sse) inputs.push('sse')
  if (argv.streamableHttp) inputs.push('streamableHttp')
  if (inputs.length === 0)
    return {
      error:
        'Error: You must specify one of --stdio, --sse, or --streamableHttp',
    }
  if (inputs.length > 1)
    return {
      error:
        'Error: Specify only one of --stdio, --sse, or --streamableHttp, not multiple',
    }
  return { input: inputs[0] }
}

/**
 * A stateful session's idle lifetime, or why the flag's value is unusable.
 *
 * A stateful session owns a child process, and the only thing that used to
 * release it was the client explicitly deleting the session. A client that
 * crashes, is force-quit, or simply closes its transport never sends that, so
 * every such disconnect leaked a process for the lifetime of the gateway.
 * Thirty minutes is far longer than any gap between calls in a live session
 * and still bounds what a vanished client can strand.
 */
export function sessionTimeoutOf(
  argv: Cli,
): { sessionTimeout: number } | { error: string } {
  if (typeof argv.sessionTimeout !== 'number')
    return { sessionTimeout: defaultSessionTimeout }
  // Negated so that NaN (`--sessionTimeout 30m`) fails too: `NaN <= 0` is
  // false, and it used to switch the default timeout off.
  if (!(argv.sessionTimeout > 0))
    return {
      error: `Error: \`sessionTimeout\` must be a positive number, received: ${argv.sessionTimeout}`,
    }
  return { sessionTimeout: argv.sessionTimeout }
}

/**
 * The address to listen on, if `--host` names one, or why it cannot be used.
 *
 * Unset, a gateway listens on every interface, as it always has. The bridges
 * listen on nothing, and a flag that restricts who can connect must not be
 * accepted and then ignored, so there it is an error. So is an empty value,
 * as `--host "$UNSET_VARIABLE"` gives, which `listen` would also take to mean
 * every interface.
 */
export function hostOf(
  argv: Cli,
): { host: string | undefined } | { error: string } {
  if (argv.host === undefined) return { host: undefined }
  if (argv.outputTransport === 'stdio')
    return {
      error:
        'Error: --host applies only when supergateway listens (stdio→SSE, stdio→WS or stdio→Streamable HTTP)',
    }
  const host = normalizeHost(argv.host)
  if (host === '')
    return { error: 'Error: --host needs an address, e.g. 127.0.0.1 or ::1' }
  return { host }
}
