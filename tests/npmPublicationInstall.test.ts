import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { waitForPublication } from '../scripts/wait-for-npm-publication.mjs'

const npm =
  process.env.npm_execpath ??
  resolve(
    dirname(process.execPath),
    process.platform === 'win32'
      ? 'node_modules/npm/bin/npm-cli.js'
      : '../lib/node_modules/npm/bin/npm-cli.js',
  )

test(
  'real npm pack recovers from cached metadata that lags visible version and tag endpoints',
  { timeout: 60000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'npm-publication-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const source = join(root, 'source')
    const output = join(root, 'output')
    mkdirSync(source)
    mkdirSync(output)
    const version = '4.0.0-rc.1'
    writeFileSync(
      join(source, 'package.json'),
      JSON.stringify({ name: 'supergateway', version }),
    )
    const run = (args: string[], cwd = root) =>
      new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        execFile(
          process.execPath,
          [npm, ...args],
          {
            cwd,
            timeout: 15000,
            encoding: 'utf8',
            env: {
              ...process.env,
              npm_config_cache: join(root, 'cache'),
              npm_config_update_notifier: 'false',
            },
          },
          (error, stdout, stderr) => {
            if (error) reject(Object.assign(error, { stdout, stderr }))
            else resolve({ stdout, stderr })
          },
        )
      })
    const local = JSON.parse(
      (
        await run(
          ['pack', '--json', '--ignore-scripts', '--pack-destination', output],
          source,
        )
      ).stdout,
    )[0]
    const bytes = readFileSync(join(output, local.filename))
    const integrity =
      'sha512-' + createHash('sha512').update(bytes).digest('base64')
    let rootRequests = 0
    let registryUrl = ''
    const metadata = () => ({
      name: 'supergateway',
      version,
      dist: { integrity, tarball: registryUrl + '/artifact.tgz' },
    })
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/artifact.tgz') {
        res.end(bytes)
        return
      }
      if (req.url === `/supergateway/${version}`) {
        res.end(JSON.stringify(metadata()))
        return
      }
      if (req.url === '/-/package/supergateway/dist-tags') {
        res.end(JSON.stringify({ next: version }))
        return
      }
      if (req.url === '/supergateway') {
        const visible = ++rootRequests > 1
        // The first npm lookup caches a valid but stale package index.
        res.setHeader('cache-control', 'public, max-age=600')
        res.end(
          JSON.stringify({
            name: 'supergateway',
            'dist-tags': visible ? { next: version } : {},
            versions: visible ? { [version]: metadata() } : {},
          }),
        )
        return
      }
      res.writeHead(404)
      res.end('{}')
    })
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
    t.after(
      () =>
        new Promise<void>((ok) => {
          server.closeAllConnections()
          server.close(() => ok())
        }),
    )
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    registryUrl = `http://127.0.0.1:${address.port}`
    let downloads = 0
    const errors: string[] = []
    const tags = await waitForPublication({
      version,
      channel: 'next',
      integrity,
      attempts: 3,
      request: (url, options) =>
        fetch(new URL(new URL(url).pathname, registryUrl), options),
      sleep: async () => {},
      downloadPackage: async () => {
        downloads++
        try {
          const { stdout } = await run([
            'pack',
            `supergateway@${version}`,
            '--registry',
            registryUrl,
            '--prefer-online',
            '--ignore-scripts',
            '--json',
            '--pack-destination',
            output,
          ])
          return JSON.parse(stdout)[0]
        } catch (error) {
          errors.push(JSON.parse(error.stdout).error.code)
          throw error
        }
      },
    })
    assert.deepEqual(errors, ['ETARGET'])
    assert.equal(downloads, 2)
    assert.ok(rootRequests >= 2, 'npm revalidates the stale package index')
    assert.deepEqual(tags, { next: version })
    assert.deepEqual(readFileSync(join(output, local.filename)), bytes)
  },
)
