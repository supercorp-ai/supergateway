import type { ChildProcessWithoutNullStreams } from 'child_process'

/**
 * How to start an MCP server.
 *
 * - A string is a shell command line: `--stdio`, and `stdio` in a config file.
 * - `command` + `args` is an argument vector run without a shell, as Claude
 *   Desktop and other clients run the servers in their config files. Each
 *   argument reaches the server exactly as written, with no quoting rules.
 *
 * Both object forms may add `env` (merged over the gateway's own environment,
 * which a child inherits anyway) and a working directory.
 */
export type ChildCommand =
  | string
  | { stdio: string; env?: Record<string, string>; cwd?: string }
  | {
      command: string
      args: string[]
      env?: Record<string, string>
      cwd?: string
    }

type Spawn = typeof import('child_process').spawn

/**
 * Starts `command` with `spawn`, which the caller passes in: each gateway
 * imports its own, and tests replace that module per test.
 *
 * A plain string is spawned exactly as `--stdio` always has been.
 */
export function spawnCommand(
  spawn: Spawn,
  command: ChildCommand,
  options: { shell: boolean; detached: boolean },
): ChildProcessWithoutNullStreams {
  if (typeof command === 'string') return spawn(command, options)
  const launch = {
    ...options,
    ...(command.env ? { env: { ...process.env, ...command.env } } : {}),
    ...(command.cwd ? { cwd: command.cwd } : {}),
  }
  if ('stdio' in command) return spawn(command.stdio, launch)
  return spawn(command.command, command.args, { ...launch, shell: false })
}

/** The command as the startup log shows it. */
export function describeCommand(command: ChildCommand): string {
  if (typeof command === 'string') return command
  if ('stdio' in command) return command.stdio
  return [command.command, ...command.args].join(' ')
}
