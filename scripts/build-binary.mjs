#!/usr/bin/env node
// Build a standalone supergateway executable for the platform this runs on
// (#50): one file with Node inside, so it runs where Node is not installed.
//
// It is a Node single executable application: dist/ bundled into one
// CommonJS file, injected into a copy of the running Node binary. Built on
// Node 24 deliberately. From Node 25 the official Linux binaries link
// libatomic, which stock Debian, Ubuntu and python-slim images do not have, so
// a Node 26 executable fails to start on them; a Node 24 one starts with
// nothing installed. Node 24 also cannot take an ES module as the entry, hence
// CommonJS, and has no `--build-sea`, hence postject.
//
// Each platform is built on its own machine: the executable is this Node, so
// cross-building would mean injecting into a downloaded one, and the Windows
// result of that keeps a broken signature directory.
//
// Usage: npm run build && node scripts/build-binary.mjs
// Writes .binary/supergateway-<target>.tar.gz (.zip on Windows) and prints its
// path. Set SUPERGATEWAY_BINARY_KEEP=1 to keep .binary/<target>/ for testing.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import * as esbuild from 'esbuild'

const repository = resolve(import.meta.dirname, '..')
const { version } = JSON.parse(
  readFileSync(join(repository, 'package.json'), 'utf8'),
)

const node = process.versions.node
if (node.split('.')[0] !== '24') {
  console.error(
    `Run this with Node 24, not ${node}: the executable is the running Node, and only 24 runs on stock Linux without libatomic.`,
  )
  process.exit(1)
}
if (!existsSync(join(repository, 'dist/index.js'))) {
  console.error('dist/index.js is missing. Run `npm run build` first.')
  process.exit(1)
}

// glibc reports its version; musl (Alpine) does not.
const musl =
  process.platform === 'linux' &&
  !process.report.getReport().header.glibcVersionRuntime
const target = [
  { darwin: 'darwin', linux: musl ? 'linux-musl' : 'linux', win32: 'win' }[
    process.platform
  ],
  process.arch,
].join('-')
if (target.startsWith('undefined')) {
  console.error(`No executable is built for ${process.platform}.`)
  process.exit(1)
}

const work = join(repository, '.binary', target)
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
// COPYFILE_DISABLE keeps macOS tar from adding ._ metadata files.
const run = (command, args) =>
  execFileSync(command, args, {
    stdio: 'inherit',
    cwd: work,
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })

// 1. One CommonJS file. getVersion reads package.json beside dist/, which an
//    executable does not have, so the version is written in instead.
const bundle = join(work, 'supergateway.cjs')
const { metafile } = await esbuild.build({
  entryPoints: [join(repository, 'dist/index.js')],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  outfile: bundle,
  metafile: true,
  logLevel: 'warning',
  plugins: [
    {
      name: 'version',
      setup(build) {
        build.onLoad({ filter: /dist[\\/]lib[\\/]getVersion\.js$/ }, () => ({
          contents: `export function getVersion() { return ${JSON.stringify(version)} }`,
          loader: 'js',
        }))
      },
    },
  ],
})
const native = Object.keys(metafile.inputs).filter((f) => f.endsWith('.node'))
if (native.length) {
  console.error(`Native addons cannot be embedded: ${native.join(', ')}`)
  process.exit(1)
}

// 2. The blob Node runs on start. No code cache or snapshot: each is tied to
//    the exact build and only saves about 60 ms.
writeFileSync(
  join(work, 'sea-config.json'),
  JSON.stringify({
    main: bundle,
    output: join(work, 'sea.blob'),
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    useSnapshot: false,
  }),
)
run(process.execPath, ['--experimental-sea-config', 'sea-config.json'])

// 3. Inject it into a copy of this Node.
const executable = join(
  work,
  process.platform === 'win32' ? 'supergateway.exe' : 'supergateway',
)
copyFileSync(process.execPath, executable)
if (process.platform === 'darwin')
  run('codesign', ['--remove-signature', executable])
if (process.platform === 'win32') removeWindowsSignature(executable)
const postject = join(repository, 'node_modules/postject/dist/cli.js')
run(process.execPath, [
  postject,
  executable,
  'NODE_SEA_BLOB',
  join(work, 'sea.blob'),
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(process.platform === 'darwin'
    ? ['--macho-segment-name', 'NODE_SEA']
    : []),
])
// Apple Silicon kills an unsigned executable on sight. An ad-hoc signature is
// enough to run; notarization is a separate, paid step.
if (process.platform === 'darwin') run('codesign', ['--sign', '-', executable])

// It has to be what it says it is before it is archived.
const reported = execFileSync(executable, ['--version'], {
  encoding: 'utf8',
}).trim()
if (reported !== version) {
  console.error(`The executable reports ${reported}, expected ${version}.`)
  process.exit(1)
}

// 4. The notices the MIT and other licenses require for redistribution: this
//    project's, Node's, and every bundled package's.
writeFileSync(join(work, 'LICENSE'), readFileSync(join(repository, 'LICENSE')))
writeFileSync(
  join(work, 'THIRD_PARTY_LICENSES.txt'),
  await thirdPartyLicenses(Object.keys(metafile.inputs)),
)

const archive = join(
  repository,
  '.binary',
  `supergateway-${target}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`,
)
rmSync(archive, { force: true })
const files = [
  executable.slice(work.length + 1),
  'LICENSE',
  'THIRD_PARTY_LICENSES.txt',
]
// bsdtar ships with Windows 10 and later, and `-a` picks zip from the name.
if (process.platform === 'win32') run('tar', ['-a', '-cf', archive, ...files])
else run('tar', ['-czf', archive, ...files])

const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex')
console.log(
  `${archive}\nsha256 ${sha256}\nsupergateway ${version}, Node ${node}, ${target}`,
)
if (!process.env.SUPERGATEWAY_BINARY_KEEP) {
  for (const temporary of ['supergateway.cjs', 'sea-config.json', 'sea.blob'])
    rmSync(join(work, temporary), { force: true })
}

function removeWindowsSignature(file) {
  // Node's own Authenticode signature no longer matches once the blob is in.
  // signtool is in the Windows SDK, not on PATH.
  const kits = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin'
  const signtool = existsSync(kits)
    ? readdirSync(kits)
        .filter((entry) => /^10\./.test(entry))
        .sort()
        .reverse()
        .map((entry) => join(kits, entry, 'x64', 'signtool.exe'))
        .find((candidate) => existsSync(candidate))
    : undefined
  if (!signtool) {
    console.error(
      'signtool.exe was not found; it is needed to remove the signature Node ships with.',
    )
    process.exit(1)
  }
  run(signtool, ['remove', '/s', file])
}

async function thirdPartyLicenses(inputs) {
  const sections = []
  // Node's LICENSE sits next to the binary on Windows and one level up
  // elsewhere; the official Docker images drop it, so fetch it then.
  const beside = [
    join(dirname(process.execPath), 'LICENSE'),
    join(dirname(dirname(process.execPath)), 'LICENSE'),
  ].find((candidate) => existsSync(candidate))
  const nodeLicense = beside
    ? readFileSync(beside, 'utf8')
    : await fetch(
        `https://raw.githubusercontent.com/nodejs/node/v${node}/LICENSE`,
      ).then((response) => {
        if (!response.ok) throw new Error(`Node LICENSE: ${response.status}`)
        return response.text()
      })
  sections.push(`Node.js ${node}\n\n${nodeLicense}`)

  const packages = new Map()
  for (const input of inputs) {
    const match = /node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(input)
    if (!match) continue
    const root = join(repository, input.slice(0, match.index + match[0].length))
    if (packages.has(root)) continue
    const manifest = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8'),
    )
    const file = readdirSync(root).find((entry) =>
      /^(licen[sc]e|copying)(\.|$)/i.test(entry),
    )
    packages.set(
      root,
      `${manifest.name} ${manifest.version} (${manifest.license ?? 'see package'})\n\n` +
        (file
          ? readFileSync(join(root, file), 'utf8')
          : `No license file is distributed with this package; its package.json declares ${manifest.license}.`),
    )
  }
  sections.push(...[...packages.values()].sort())
  return (
    `supergateway ${version} bundles Node.js and the packages below.\n\n` +
    sections.join(`\n\n${'='.repeat(78)}\n\n`) +
    '\n'
  )
}
