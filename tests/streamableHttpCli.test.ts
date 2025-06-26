import { test } from 'node:test'
import assert from 'node:assert/strict'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'

test('yargs parses streamableHttp outputTransport', () => {
  const argv = yargs(
    hideBin([
      'node',
      '',
      '--stdio',
      'true',
      '--outputTransport',
      'streamableHttp',
    ]),
  )
    .option('stdio', { type: 'string' })
    .option('outputTransport', {
      type: 'string',
      choices: ['stdio', 'sse', 'ws', 'streamableHttp'],
    })
    .parseSync()
  assert.strictEqual(argv.outputTransport, 'streamableHttp')
})
