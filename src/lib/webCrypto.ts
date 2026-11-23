import crypto from 'node:crypto'

/**
 * The global `crypto` on Node 18, which has it only behind a flag.
 *
 * Node 20 and later define it. `@hono/node-server` 1.19 set it to
 * `node:crypto` where it was missing; 2.x, which a fresh install gives the
 * MCP SDK since 4.2.3, no longer does and reads it as it loads, so on Node 18
 * every Streamable HTTP request failed with "crypto is not defined".
 * Supergateway has required Node 20 since 4.0.0, but npm only warns about
 * that, and 4.2.2 still ran on Node 18. This sets it as 1.19 did. Where
 * `crypto` is defined, nothing changes.
 *
 * Imported before anything that loads the SDKs.
 */
export function provideWebCrypto(target: { crypto?: unknown } = globalThis) {
  target.crypto ??= crypto
}

provideWebCrypto()
