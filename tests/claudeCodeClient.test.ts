import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  launchGateway,
  unusedPort,
  peerCommand,
} from './helpers/gateway-process.js'

/**
 * Claude Code's CLI as a real client.
 *
 * Every driver in `tests/clients/` is an SDK used the way its README shows.
 * None of them is the thing most supergateway users are actually pointing at
 * it: an assistant application, with its own client stack, its own config
 * format and its own idea of what "connected" means. The GUI applications
 * cannot be driven headlessly, but the CLI shares their MCP client, and
 * `claude mcp list` performs a real handshake — initialize, capability
 * exchange, tools/list — with no model call, so this runs offline and costs
 * nothing.
 *
 * `CLAUDE_CONFIG_DIR` points at a throwaway directory for the whole exchange.
 * Without it `claude mcp add` writes a server entry into the developer's own
 * `~/.claude.json`, keyed by this repository's path, and leaves it there.
 *
 * Skipped rather than failed when the CLI is absent, which is the case on CI:
 * a client that is not installed is not evidence of anything.
 */
const HAVE_CLAUDE =
  spawnSync('claude', ['--version'], { stdio: 'ignore' }).status === 0

const MODES = [
  {
    label: 'stateful streamable HTTP',
    args: ['--outputTransport', 'streamableHttp', '--stateful'],
    transport: 'http',
    path: '/mcp',
  },
  {
    label: 'stateless streamable HTTP',
    args: ['--outputTransport', 'streamableHttp'],
    transport: 'http',
    path: '/mcp',
  },
  {
    label: 'SSE',
    args: ['--outputTransport', 'sse'],
    transport: 'sse',
    path: '/sse',
  },
] as const

for (const mode of MODES) {
  test(
    `Claude Code connects to the gateway over ${mode.label}`,
    {
      skip: HAVE_CLAUDE ? false : 'the claude CLI is not installed',
      timeout: 120000,
    },
    async (t) => {
      const port = await unusedPort()
      const gateway = launchGateway(t, [
        '--stdio',
        peerCommand,
        '--port',
        String(port),
        ...mode.args,
      ])
      await gateway.ready()

      const config = mkdtempSync(join(tmpdir(), 'supergateway-claude-'))
      t.after(() => rmSync(config, { recursive: true, force: true }))
      const env = { ...process.env, CLAUDE_CONFIG_DIR: config }
      const claude = (args: string[]) =>
        execFileSync('claude', args, { env, encoding: 'utf8', timeout: 90000 })

      claude([
        'mcp',
        'add',
        '--transport',
        mode.transport,
        'probe',
        `http://127.0.0.1:${port}${mode.path}`,
      ])

      // `mcp get` health-checks the server, so this is a handshake and not a
      // reading of the config file back.
      const status = claude(['mcp', 'get', 'probe'])
      assert.match(
        status,
        /Status:.*Connected/,
        `Claude Code could not connect over ${mode.label}:\n${status}\n${gateway.errors()}`,
      )
    },
  )
}
