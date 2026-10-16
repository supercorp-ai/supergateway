// Temporary: which way of closing a child's stdin makes the parent's writes
// fail, on this OS, with and without a shell between them.
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const variants = {
  // fault-peer.mjs: destroy the stream, then close fd 0.
  'destroy, close fd 0': `
    const closed = once(process.stdin, 'close')
    process.stdin.destroy()
    await closed
    try { closeSync(0) } catch (e) { say('close0 ' + e.code) }`,
  'destroy only': `
    const closed = once(process.stdin, 'close')
    process.stdin.destroy()
    await closed`,
  'close fd 0 only': `
    try { closeSync(0) } catch (e) { say('close0 ' + e.code) }`,
  'handle close': `
    await new Promise((r) => process.stdin._handle.close(r))`,
}
const dir = mkdtempSync(join(tmpdir(), 'stdin-close-'))
for (const [name, body] of Object.entries(variants)) {
  for (const reading of ['readline', true, false]) {
    const file = join(dir, `${Object.keys(variants).indexOf(name)}-${reading}.mjs`)
    writeFileSync(
      file,
      `import { once } from 'node:events'
import { closeSync } from 'node:fs'
const say = (s) => process.stdout.write(s + '\\n')
setInterval(() => {}, 1 << 30)
${reading === 'readline' ? "import('node:readline').then(({ createInterface }) => createInterface({ input: process.stdin }).on('line', () => {}))" : reading ? "process.stdin.on('data', () => {})" : ''}
await new Promise((r) => setTimeout(r, 200))
${reading || !body.includes('process.stdin') ? body : "process.stdin.on('data', () => {})\n" + body}
say('closed')
`,
    )
    for (const shell of [false, true]) {
      const result = await new Promise((resolve) => {
        const c = shell
          ? spawn(`"${process.execPath}" "${file}"`, { shell: true })
          : spawn(process.execPath, [file])
        let out = ''
        let err = ''
        let exit = 'running'
        c.stderr.on('data', (d) => (err += d))
        c.on('exit', (code, signal) => (exit = `exit ${code ?? signal}`))
        const timer = setTimeout(() => {
          c.kill()
          resolve(`writes still accepted after 5s (${out.trim()}; ${exit}; ${err.trim().split('\n').slice(0, 2).join(' / ')})`)
        }, 5000)
        c.stdin.on('error', (e) => {
          clearTimeout(timer)
          c.kill()
          resolve(`write failed: ${e.code} (${out.trim()}; ${exit})`)
        })
        c.stdout.on('data', (d) => {
          out += d
          if (/closed/.test(out)) {
            const pump = setInterval(() => c.stdin.write('x\n'), 50)
            c.once('exit', () => clearInterval(pump))
          }
        })
      })
      console.log(`${name}${reading === 'readline' ? ', reading lines' : reading ? ', after reading' : ''}, shell=${shell}: ${result}`)
    }
  }
}
process.exit(0)
