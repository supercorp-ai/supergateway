import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OwnedChildProcesses } from '../src/lib/ownedChildProcesses.js'
import { spawnCommand } from '../src/lib/childCommand.js'

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
      const logger = {
        info() {},
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
      t.after(() => {
        for (const pid of [serverPid, server.pid, unrelated.pid]) {
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
      if (shell)
        assert.notEqual(serverPid, server.pid, 'server runs beneath cmd.exe')
      assert.doesNotThrow(() => process.kill(serverPid!, 0))
      await stop()
      await stop()
      await owner.close()
      const deadline = Date.now() + 1000
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
    },
  )
}
