import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseUpstreamUrl,
  redactQuery,
  redactUrl,
} from '../src/lib/urlCredentials.js'

test('redactUrl hides the user, the password and sensitive query values', () => {
  const url = new URL(
    'https://me:hunter2@example.com/sse?token=abc&api_key=k&page=2',
  )
  assert.equal(
    redactUrl(url),
    'https://redacted:redacted@example.com/sse?token=redacted&api_key=redacted&page=2',
  )
  assert.equal(url.password, 'hunter2', 'the URL itself is left alone')
  assert.equal(
    redactUrl(new URL('https://example.com/mcp?page=2')),
    'https://example.com/mcp?page=2',
    'a URL without credentials is printed as it was',
  )
})

test('parseUpstreamUrl refuses a user or password, and names neither', () => {
  for (const url of [
    'https://me:hunter2@example.com/sse',
    'https://me@example.com/sse',
    'https://:hunter2@example.com/sse',
  ]) {
    assert.throws(
      () => parseUpstreamUrl(url),
      (error: Error) =>
        /Credentials in the upstream URL are not supported/.test(
          error.message,
        ) &&
        !error.message.includes('hunter2') &&
        !error.message.includes('me@'),
      url,
    )
  }
  assert.equal(
    parseUpstreamUrl('https://example.com/mcp?token=abc').href,
    'https://example.com/mcp?token=abc',
    'a URL without credentials is used as given, query included',
  )
})

test('redactQuery hides every query value, whatever its name', () => {
  assert.equal(
    redactQuery('https://example.com/mcp?k=abc&profile=dev&k=def#top'),
    'https://example.com/mcp?k=redacted&profile=redacted#top',
  )
})

test('redactQuery leaves a URL with no query as it was written', () => {
  // Not `new URL(...).href`, which would add the slash and lower the case.
  for (const url of ['https://Example.com', 'http://h/sse', 'http://h/mcp#x'])
    assert.equal(redactQuery(url), url)
})
