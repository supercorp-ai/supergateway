import type { Client } from '@modelcontextprotocol/sdk/client/index.js'

/**
 * The result schema for a relayed request: the result exactly as the server
 * sent it, like `z.any()`.
 *
 * The SDK only calls `parse` on it (before 1.2x) or `safeParse` (since, for a
 * schema that isn't zod 4's), so this works with whichever zod the installed
 * SDK uses. A `z.any()` from supergateway's own zod breaks an SDK that keeps a
 * different zod major (`keyValidator._parse is not a function`).
 */
export const anyResult = {
  parse: (value: unknown) => value,
  safeParse: (value: unknown) => ({ success: true as const, data: value }),
} as unknown as Parameters<Client['request']>[1]
