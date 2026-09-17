import { test } from 'node:test'
import assert from 'node:assert/strict'
import { waitForPublication } from '../scripts/wait-for-npm-publication.mjs'

const version = '4.0.0-rc.0'
const integrity = 'sha512-tested-artifact'
const metadata = { version, dist: { integrity } }
function registry(replies: Array<[number, object]>) {
  let calls = 0
  const request = async () => {
    const reply = replies[calls++]
    assert.ok(reply, 'unexpected registry request')
    return new Response(JSON.stringify(reply[1]), { status: reply[0] })
  }
  return { request, calls: () => calls }
}
const options = { version, channel: 'next', integrity, attempts: 3 }

test('npm publication waits for both package visibility and the requested dist-tag', async () => {
  const remote = registry([
    [404, {}],
    [200, metadata],
    [200, { latest: '3.4.3' }],
    [200, metadata],
    [200, { latest: '3.4.3', next: version }],
  ])
  const pauses: number[] = []
  await waitForPublication({
    ...options,
    request: remote.request,
    sleep: async (ms) => {
      pauses.push(ms)
    },
  })
  assert.equal(remote.calls(), 5)
  assert.deepEqual(pauses, [5000, 5000])
})

test('npm publication stops after the bounded number of missing-package checks', async () => {
  const remote = registry([
    [404, {}],
    [404, {}],
    [404, {}],
  ])
  let pauses = 0
  await assert.rejects(
    waitForPublication({
      ...options,
      request: remote.request,
      sleep: async () => {
        pauses++
      },
    }),
    /after 3 checks/,
  )
  assert.equal(remote.calls(), 3)
  assert.equal(pauses, 2)
})

test('npm publication does not retry mismatched package bytes', async () => {
  const remote = registry([
    [200, { version, dist: { integrity: 'sha512-other' } }],
  ])
  await assert.rejects(
    waitForPublication({ ...options, request: remote.request }),
    /Published package differs/,
  )
  assert.equal(remote.calls(), 1)
})

test('npm publication does not retry an unexpected version or authorization error', async () => {
  for (const [status, body] of [
    [200, { ...metadata, version: '4.0.0-rc.1' }],
    [403, {}],
  ] as Array<[number, object]>) {
    const remote = registry([[status, body]])
    await assert.rejects(
      waitForPublication({ ...options, request: remote.request }),
    )
    assert.equal(remote.calls(), 1)
  }
})

test('npm publication tolerates registry throttling and temporary tag unavailability', async () => {
  const remote = registry([
    [429, {}],
    [200, metadata],
    [503, {}],
    [200, metadata],
    [200, { next: version }],
  ])
  await waitForPublication({
    ...options,
    request: remote.request,
    sleep: async () => {},
  })
  assert.equal(remote.calls(), 5)
})

test('npm publication waits until npm pack can download the visible version', async () => {
  const remote = registry([
    [200, metadata],
    [200, { next: version }],
    [200, metadata],
    [200, { next: version }],
  ])
  let downloads = 0
  let pauses = 0
  const tags = await waitForPublication({
    ...options,
    request: remote.request,
    downloadPackage: async () => {
      if (++downloads === 1)
        throw Object.assign(new Error('npm pack has stale metadata'), {
          stdout: JSON.stringify({ error: { code: 'ETARGET' } }),
        })
      return { version, integrity }
    },
    sleep: async () => {
      pauses++
    },
  })
  assert.equal(downloads, 2)
  assert.equal(pauses, 1)
  assert.equal(remote.calls(), 4)
  assert.deepEqual(tags, { next: version })
})

for (const code of ['ETARGET', 'E404'])
  test(`npm publication bounds repeated ${code} download failures`, async () => {
    const remote = registry(
      Array.from({ length: 3 }, () => [
        [200, metadata],
        [200, { next: version }],
      ]).flat() as Array<[number, object]>,
    )
    let downloads = 0
    let pauses = 0
    await assert.rejects(
      waitForPublication({
        ...options,
        request: remote.request,
        downloadPackage: async () => {
          downloads++
          throw Object.assign(new Error('not visible'), {
            stdout: JSON.stringify({ error: { code } }),
          })
        },
        sleep: async () => {
          pauses++
        },
      }),
      /after 3 checks/,
    )
    assert.equal(downloads, 3)
    assert.equal(pauses, 2)
  })

test('npm publication fails immediately for corrupt bytes, wrong versions and non-visibility download errors', async () => {
  for (const result of [
    { version, integrity: 'sha512-other-bytes' },
    { version: 'wrong-version', integrity },
    Object.assign(new Error('auth'), {
      stdout: JSON.stringify({ error: { code: 'E401' } }),
    }),
    Object.assign(new Error('corrupt'), {
      stdout: JSON.stringify({ error: { code: 'EINTEGRITY' } }),
    }),
    Object.assign(new Error('unexpected'), { stdout: 'not JSON' }),
  ]) {
    const remote = registry([
      [200, metadata],
      [200, { next: version }],
    ])
    let downloads = 0
    let pauses = 0
    await assert.rejects(
      waitForPublication({
        ...options,
        request: remote.request,
        downloadPackage: async () => {
          downloads++
          if (result instanceof Error) throw result
          return result
        },
        sleep: async () => {
          pauses++
        },
      }),
    )
    assert.equal(downloads, 1)
    assert.equal(pauses, 0)
  }
})
