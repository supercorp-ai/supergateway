# Contributing

Issues and pull requests are welcome. For questions and discussion, join us on [Discord](https://discord.gg/CudcAH53yF). Please follow the [Code of Conduct](CODE_OF_CONDUCT.md), and report security issues privately as described in [SECURITY.md](SECURITY.md).

## Setup

You need Node **24+**. With [nvm](https://github.com/nvm-sh/nvm):

```bash
nvm install 24
nvm use 24
npm install
npm run build
npm test
```

`tests/helpers/mock-mcp-server.js` provides a local MCP server, so the suite runs without network access.

Two more checks compare your build with the last release, and need the network to fetch it. CI runs both on every pull request:

```bash
npm run test:versions   # the same client against the release and this build, side by side
npm run test:released   # the release's own end-to-end tests, run against this build
```

A difference that is meant is written down with its reason in `tests/crossVersion.intended.ts` or `tests/releasedTests.intended.json`; any other fails.

## Pull requests

- Add a test for what you change. A bug fix comes with a test that fails without it.
- Coverage stays at 100% of lines, branches and MC/DC; CI's coverage gate checks it.
- CI runs the suite on Linux, macOS and Windows, on every supported Node version, and against the range of MCP SDK versions we support. All of it must pass.
- Don't break existing clients: if a change is visible to clients, say so in the PR and why.
- Keep the PR focused; separate refactors from fixes.

Everyone whose issue or PR goes into a release is added to the contributors list in the README.
