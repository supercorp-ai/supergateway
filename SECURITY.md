# Security policy

## Reporting a vulnerability

Please don't open a public issue. [Report it privately on GitHub](https://github.com/supercorp-ai/supergateway/security/advisories/new) (Security tab → Report a vulnerability).

Include the supergateway version, the command or config you ran (without secrets), and what an attacker could do. We aim to reply within 3 working days, and we'll credit you in the release notes unless you'd rather not be named.

## In scope

Anything that lets someone get past what the gateway is set up to allow, for example:

- reaching a server without a valid key when `--apiKey` (or `apiKey` in a config file) is set
- a browser on another origin reaching a gateway that doesn't allow it with `--cors`
- one client reading or affecting another client's session or server
- secrets (keys, `env` values, headers) ending up in logs or `--printConfig` output

The MCP servers you run behind the gateway, and what they can do, are out of scope: report those to their authors.

## Maintainers

Security reports are handled by [@Nedomas](https://github.com/Nedomas) (Domas Bitvinskas, [domas@supercorp.ai](mailto:domas@supercorp.ai)), Supergateway's creator and maintainer.

## Supported versions

Fixes go into the latest 4.x release. Please check the newest version before reporting.
