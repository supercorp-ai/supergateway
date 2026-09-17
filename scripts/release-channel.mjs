import assert from 'node:assert/strict'

// Docker follows the npm release channel; a version number alone cannot tell
// whether a stable-looking version was deliberately published under `next`.
export function releaseChannel(version, distTags, requested = 'auto') {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/)
  assert.ok(['auto', 'next', 'latest'].includes(requested))
  const channel =
    requested === 'auto'
      ? distTags.latest === version
        ? 'latest'
        : 'next'
      : requested
  assert.equal(
    distTags[channel],
    version,
    `Publish supergateway@${version} to npm with --tag ${channel} first`,
  )
  assert.ok(
    channel !== 'latest' || !version.includes('-'),
    'Prerelease versions must use the next channel',
  )
  return channel
}
