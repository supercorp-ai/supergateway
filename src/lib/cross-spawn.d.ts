// cross-spawn ships no types. This is the one part of it the gateway uses.
declare module 'cross-spawn' {
  import type { SpawnOptions } from 'node:child_process'
  const crossSpawn: {
    /**
     * How cross-spawn would start `command`: on Windows, a script found on
     * PATH (npx.cmd) becomes cmd.exe with each argument escaped for it;
     * anything else is returned as given. `file` is what was found, if
     * anything.
     */
    _parse(
      command: string,
      args: string[],
      options: SpawnOptions,
    ): {
      command: string
      args: string[]
      options: SpawnOptions
      file?: string
    }
  }
  export default crossSpawn
}
