import { build } from 'esbuild'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

// Keep the exact tested SDK in the shipped artifact. SDK package engines apply
// to development installs (Node 24); the bundled runtime is tested on Node 18+.
const result = await build({
  entryPoints: ['src/lib/modernSdk.ts'],
  outfile: 'dist/lib/modernSdk.js',
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  metafile: true,
  legalComments: 'linked',
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
})

const packages = new Map()
const vendored = new Map()
const vendorAliases = {
  ajv: 'modern-vendor-ajv',
  'ajv-formats': 'modern-vendor-ajv-formats',
  'content-type': 'modern-vendor-content-type',
  'fast-deep-equal': 'modern-vendor-fast-deep-equal',
  'fast-uri': 'modern-vendor-fast-uri',
  'json-schema-traverse': 'modern-vendor-json-schema-traverse',
}
// The SDK's own build embeds vendor code. Include those exact versions in the
// notice inventory and dependency audit rather than treating them as SDK code.
for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.includes('node_modules/')) continue
  const contents = readFileSync(input, 'utf8')
  for (const match of contents.matchAll(/\.pnpm\/([^/]+)\/node_modules\//g)) {
    const spec = match[1].split('_')[0]
    const separator = spec.lastIndexOf('@')
    const name = spec.slice(0, separator).replace('+', '/')
    vendored.set(name, spec.slice(separator + 1))
  }
}
const licenseInputs = [...Object.keys(result.metafile.inputs)]
for (const [name, version] of vendored) {
  const directory = join('node_modules', vendorAliases[name] ?? name)
  const metadata = JSON.parse(
    readFileSync(join(directory, 'package.json'), 'utf8'),
  )
  if (metadata.name !== name || metadata.version !== version)
    throw new Error(
      `Install the exact SDK vendor for audit/notices: ${name}@${version}`,
    )
  licenseInputs.push(join(directory, 'package.json'))
}
for (const input of licenseInputs) {
  if (!input.includes('node_modules/')) continue
  let directory = dirname(resolve(input))
  while (!existsSync(join(directory, 'package.json'))) {
    const parent = dirname(directory)
    if (parent === directory)
      throw new Error(`Missing package metadata for ${input}`)
    directory = parent
  }
  const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  // Some packages contain a nested package.json solely to mark ESM/CJS scope.
  while (!pkg.name) {
    directory = dirname(directory)
    if (existsSync(join(directory, 'package.json')))
      Object.assign(
        pkg,
        JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')),
      )
  }
  if (packages.has(`${pkg.name}@${pkg.version}`)) continue
  const license = [
    'LICENSE',
    'LICENSE.md',
    'LICENSE.txt',
    'license',
    'license.md',
    'LICENSE-MIT',
    'COPYING',
  ].find((name) => existsSync(join(directory, name)))
  if (!license)
    throw new Error(`Missing license text for ${pkg.name}@${pkg.version}`)
  packages.set(
    `${pkg.name}@${pkg.version}`,
    readFileSync(join(directory, license), 'utf8'),
  )
}
writeFileSync(
  'dist/lib/modernSdk.LICENSE.txt',
  [...packages]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, license]) => `## ${name}\n\n${license}`)
    .join('\n\n'),
)
writeFileSync(
  'dist/lib/modernSdk.packages.json',
  JSON.stringify([...packages.keys()].sort(), null, 2) + '\n',
)
