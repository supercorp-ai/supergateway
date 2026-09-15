import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeHeaders, isSensitiveHeader } from '../src/lib/headers.js'

/**
 * `describeHeaders` decides what a gateway says about its own configuration at
 * startup, which is the one place a credential has ever escaped into a log here.
 * The e2e tests prove each gateway calls it; these prove it is right.
 */
test('no configured headers reads as none', () => {
  assert.equal(describeHeaders({}), '(none)')
})

test('ordinary headers keep their values', () => {
  assert.equal(
    describeHeaders({ 'X-Audit': 'configured', 'x-user-id': '123' }),
    '{"X-Audit":"configured","x-user-id":"123"}',
  )
})

// `length` is a legal header name, which is why `headers.length` is not an
// acceptable emptiness check even though it looks like one.
test('a header named length is reported like any other', () => {
  assert.equal(
    describeHeaders({ length: 'custom-value' }),
    '{"length":"custom-value"}',
  )
})

test('credential values are redacted, and their names are not', () => {
  assert.equal(
    describeHeaders({ 'x-user-id': '123', Authorization: 'Bearer abc' }),
    '{"x-user-id":"123","Authorization":"<redacted>"}',
  )
})

// Each name contains only one sensitive segment. A compound such as
// x-session-token would still pass if recognition of session regressed.
for (const name of [
  'X-ApiKey',
  'X-Auth',
  'X-Credential',
  'X-Credentials',
  'X-Passwd',
  'X-Password',
  'X-Session',
]) {
  test(`${name} is independently recognized and redacted`, () => {
    assert.equal(isSensitiveHeader(name), true)
    assert.deepEqual(
      JSON.parse(
        describeHeaders({ [name]: 'sensitive-value', 'X-Audit': 'configured' }),
      ),
      { [name]: '<redacted>', 'X-Audit': 'configured' },
    )
  })
}

test('sensitivity is decided per whole segment, not by substring', () => {
  // Matched: the segment is exactly a sensitive word.
  for (const name of [
    'Authorization',
    'authorization',
    'AUTHORIZATION',
    'x-api-key',
    'x_api_key',
    'Proxy-Authorization',
    'Cookie',
    'set-cookie',
    'x-session-token',
    'x-refresh-token',
    'client-secret',
    'x-signature',
  ])
    assert.equal(isSensitiveHeader(name), true, `${name} should be redacted`)

  // Not matched: a sensitive word appears only *inside* a segment. Substring
  // matching would redact all of these, which is why the segment split exists.
  // Similar-looking words stay readable when no whole segment matches.
  for (const name of [
    'x-monkey',
    'x-keying',
    'x-tokenizer',
    'x-authentic',
    'content-type',
    'X-Audit',
    'length',
  ])
    assert.equal(
      isSensitiveHeader(name),
      false,
      `${name} should not be redacted`,
    )
})
