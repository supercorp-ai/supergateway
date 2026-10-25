# Contributing

Thanks for helping! Bug reports, fixes, docs and ideas are all welcome. Everyone whose issue or pull request goes into a release is added to the contributors list in the README.

- **Questions:** [Discord](https://discord.gg/CudcAH53yF) (see [SUPPORT.md](SUPPORT.md)).
- **Security issues:** report privately, see [SECURITY.md](SECURITY.md).
- **Looking for something to work on?** Try an issue labelled [good first issue](https://github.com/supercorp-ai/supergateway/labels/good%20first%20issue) or [help wanted](https://github.com/supercorp-ai/supergateway/labels/help%20wanted).
- **Planning a bigger change** (a new flag, transport or config option)? Open an issue first so we can agree on the shape before you write code.

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

You need Node **24+**. With [nvm](https://github.com/nvm-sh/nvm):

```bash
nvm install 24
nvm use 24
npm install
npm run build
npm test
```

To run one test file while you work:

```bash
npm run build && node --import tsx --test --experimental-test-module-mocks tests/apiKey.test.ts
```

End-to-end tests start the built gateway from `dist/`, so rebuild after changing `src/`. `tests/helpers/mock-mcp-server.js` is a local MCP server, so the suite runs without network access.

Two more checks compare your build with the last release and need the network. CI runs both on every pull request:

```bash
npm run test:versions   # the same client against the release and this build, side by side
npm run test:released   # the release's own end-to-end tests, run against this build
```

A difference that is meant is written down with its reason in `tests/crossVersion.intended.ts` or `tests/releasedTests.intended.json`; any other fails.

## Pull requests

- **Tests:** add one for what you change. A bug fix comes with a test that fails without it.
- **Coverage:** stays at 100% of lines, branches and MC/DC; CI checks it.
- **Platforms:** CI runs the suite on Linux, macOS and Windows, on every supported Node version, and against the supported range of MCP SDK versions. It all has to pass; if something fails only on a platform you don't have, say so and we'll help.
- **Existing users first:** if a change is visible to clients or changes a default, say so in the PR and why.
- **Focus:** one change per PR; keep refactors separate from fixes.
