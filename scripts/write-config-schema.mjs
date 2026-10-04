// Writes config.schema.json from the built loader's key tables.
// `npm run schema`; tests/configSchema.test.ts fails when the file is stale.
import { writeFileSync } from 'node:fs'
import * as prettier from 'prettier'
import { configSchema } from '../dist/config/configSchema.js'

const path = new URL('../config.schema.json', import.meta.url)
const options = await prettier.resolveConfig(path.pathname)
writeFileSync(
  path,
  await prettier.format(JSON.stringify(configSchema()), {
    ...options,
    parser: 'json',
  }),
)
console.log('Wrote config.schema.json')
