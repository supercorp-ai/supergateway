import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OwnedChildProcesses } from '../src/lib/ownedChildProcesses.js'
import { spawnCommand } from '../src/lib/childCommand.js'
import { startedAt } from './helpers/process-tree.js'
import { requestTimeout } from './helpers/gateway-process.js'

for (const shell of [true, false]) {
  test(
    `Windows cleanup removes the server tree and preserves another server (shell=${shell})`,
    { skip: process.platform !== 'win32', timeout: 15000 },
    async (t) => {
      const dir = mkdtempSync(join(tmpdir(), 'supergateway-tree-'))
      const payload = join(dir, 'server.cjs')
      writeFileSync(
        payload,
        'console.log(process.pid); setInterval(() => {}, 1000)',
      )
      const info: string[] = []
      const logger = {
        info(message: string) {
          info.push(message)
        },
        error(...args: unknown[]) {
          assert.fail(String(args))
        },
      }
      const owner = new OwnedChildProcesses(logger)
      const unrelated = spawn(process.execPath, [payload], {
        windowsHide: true,
      })
      const server = spawnCommand(
        spawn,
        shell
          ? `"${process.execPath}" "${payload}"`
          : { command: process.execPath, args: [payload] },
        owner.spawnOptions,
      )
      const stop = owner.own(server)
      let serverPid: number | undefined
      let serverStarted: Promise<string | undefined> | undefined
      t.after(async () => {
        // Only a process that is still this test's: an ended one's PID may
        // be another's by now, and taskkill /T would end that one's tree.
        const ours = [server, unrelated]
          .filter(
            ({ exitCode, signalCode }) =>
              exitCode == null && signalCode == null,
          )
          .map(({ pid }) => pid)
        if (
          serverPid &&
          (await serverStarted) !== undefined &&
          (await startedAt(serverPid)) === (await serverStarted)
        )
          ours.push(serverPid)
        for (const pid of ours) {
          if (!pid) continue
          try {
            execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
              windowsHide: true,
              stdio: 'ignore',
            })
          } catch {}
        }
        server.stdin.destroy()
        server.stdout.destroy()
        server.stderr.destroy()
        unrelated.stdin.destroy()
        unrelated.stdout.destroy()
        unrelated.stderr.destroy()
        rmSync(dir, { recursive: true, force: true, maxRetries: 10 })
      })
      serverPid = await new Promise<number>((resolve, reject) => {
        let output = ''
        server.once('error', reject)
        server.stdout.on('data', (chunk) => {
          output += String(chunk)
          if (/^\d+\r?\n/.test(output)) resolve(Number(output.trim()))
        })
      })
      serverStarted = startedAt(serverPid)
      if (shell)
        assert.notEqual(serverPid, server.pid, 'server runs beneath cmd.exe')
      assert.doesNotThrow(() => process.kill(serverPid!, 0))
      await stop()
      await stop()
      await owner.close()
      const deadline = Date.now() + requestTimeout(1000)
      let alive = true
      while (alive && Date.now() < deadline) {
        try {
          process.kill(serverPid, 0)
        } catch {
          alive = false
        }
        if (alive) await new Promise((resolve) => setTimeout(resolve, 25))
      }
      assert.equal(
        alive,
        false,
        'stdio server must exit when owner cleanup completes',
      )
      assert.doesNotThrow(
        () => process.kill(unrelated.pid!, 0),
        'unrelated server stays alive',
      )
      // What taskkill reported ending is logged, the server itself included:
      // real taskkill output, in the form the gateway reads.
      assert.ok(
        info.some(
          (line) =>
            line.startsWith(`Ended server tree ${server.pid}: `) &&
            line.includes(` ${serverPid}<`),
        ),
        info.join('\n'),
      )
    },
  )
}
