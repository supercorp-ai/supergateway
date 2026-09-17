import { test } from 'node:test'
import assert from 'node:assert/strict'
// @ts-expect-error release tooling is intentionally plain JavaScript
import { releaseChannel } from '../scripts/release-channel.mjs'

test('publishing 4.0.0 under next does not select stable Docker aliases', () => {
  assert.equal(
    releaseChannel('4.0.0', { latest: '3.4.3', next: '4.0.0' }),
    'next',
  )
  assert.throws(() =>
    releaseChannel('4.0.0', { latest: '3.4.3', next: '4.0.0' }, 'latest'),
  )
})

test('normal stable publication retains the existing Docker release channel', () => {
  assert.equal(
    releaseChannel('4.0.0', { latest: '4.0.0', next: '4.0.0-rc.1' }),
    'latest',
  )
  assert.equal(
    releaseChannel('4.0.0', { latest: '4.0.0', next: '4.0.0' }),
    'latest',
  )
})

test('manual next publication and prereleases stay on next', () => {
  assert.equal(
    releaseChannel('4.0.0', { latest: '4.0.0', next: '4.0.0' }, 'next'),
    'next',
  )
  assert.equal(
    releaseChannel('4.0.0-rc.0', {
      latest: '3.4.3',
      next: '4.0.0-rc.0',
    }),
    'next',
  )
  assert.throws(() =>
    releaseChannel('4.0.0-rc.0', { latest: '4.0.0-rc.0' }, 'latest'),
  )
})

test('unpublished versions, mismatched channels and invalid inputs stop publication', () => {
  assert.throws(() => releaseChannel('4.0.0', { latest: '3.4.3' }))
  assert.throws(() =>
    releaseChannel('4.0.0', { latest: '3.4.3', next: '4.0.0-rc.0' }),
  )
  assert.throws(() => releaseChannel('4.0.0', {}, 'unexpected'))
  assert.throws(() => releaseChannel('4.0.0; echo bad', {}))
})
