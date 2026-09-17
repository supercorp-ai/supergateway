import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

// npm can accept a publish before its public metadata and dist-tag are visible.
export async function waitForPublication({
  version,
  channel,
  integrity,
  attempts = 40,
  intervalMs = 5000,
  request = fetch,
  sleep = delay,
}) {
  const read = async (url) => {
    const response = await request(url, {
      headers: { 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(5000),
    })
    if (
      response.status === 404 ||
      response.status === 429 ||
      response.status >= 500
    )
      return null
    assert.ok(response.ok, `npm registry returned HTTP ${response.status}`)
    return response.json()
  }
  for (let attempt = 0; attempt < attempts; attempt++) {
    const pkg = await read(
      `https://registry.npmjs.org/supergateway/${encodeURIComponent(version)}`,
    )
    if (pkg) {
      assert.equal(pkg.version, version)
      assert.equal(
        pkg.dist?.integrity,
        integrity,
        'Published package differs from the build',
      )
      const tags = await read(
        'https://registry.npmjs.org/-/package/supergateway/dist-tags',
      )
      if (tags?.[channel] === version) return
    }
    if (attempt + 1 < attempts) await sleep(intervalMs)
  }
  throw new Error(
    `npm has not made supergateway@${version} available on ${channel} after ${attempts} checks`,
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const manifest = JSON.parse(
    readFileSync(`${process.env.RUNNER_TEMP}/local-manifest.json`),
  )
  await waitForPublication({
    version: process.env.VERSION,
    channel: process.env.CHANNEL,
    integrity: manifest.integrity,
  })
  console.log(
    `supergateway@${process.env.VERSION} is visible on ${process.env.CHANNEL}`,
  )
}
