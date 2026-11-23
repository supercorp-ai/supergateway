import { webcrypto } from 'node:crypto'

/**
 * The global `crypto` on Node 18, which has it only behind a flag.
 *
 * Node 20 and later define it. `@hono/node-server` 2.x, which a fresh install
 * gives the MCP SDK, uses it on every Streamable HTTP request, so without it
 * each request on Node 18 failed with "crypto is not defined". Supergateway
 * has required Node 20 since 4.0.0, but npm only warns about that, and 4.2.2
 * still ran on Node 18. Where `crypto` is defined, nothing changes.
 */
export function provideWebCrypto(target: { crypto?: unknown } = globalThis) {
  target.crypto ??= webcrypto
}

provideWebCrypto()
