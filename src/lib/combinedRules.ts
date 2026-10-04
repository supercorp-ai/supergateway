// What several servers combined as one have in common, whichever way they
// are served: the earlier protocol versions' sessions (combinedPeer) or the
// 2026-07-28 requests (combinedModernChild).

export type Params = Record<string, any>

export const INVALID_REQUEST = -32600
export const METHOD_NOT_FOUND = -32601
export const INVALID_PARAMS = -32602
export const INTERNAL_ERROR = -32603
export const RESOURCE_NOT_FOUND = -32002

/** An error that answers a client's request as it is. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
  }
}

// The lists that are merged: the capability a server declares to have one,
// the result's key, and what names an item, for calls and for clashes.
export const LISTS = {
  'tools/list': { capability: 'tools', key: 'tools', id: 'name', what: 'tool' },
  'prompts/list': {
    capability: 'prompts',
    key: 'prompts',
    id: 'name',
    what: 'prompt',
  },
  'resources/list': {
    capability: 'resources',
    key: 'resources',
    id: 'uri',
    what: 'resource',
  },
  'resources/templates/list': {
    capability: 'resources',
    key: 'resourceTemplates',
    id: 'uriTemplate',
    what: 'resource template',
  },
} as const
export type ListMethod = keyof typeof LISTS
export const isList = (method: string): method is ListMethod => method in LISTS

// The requests that go to the one server that has what they name.
export const NAMED: Record<string, ListMethod> = {
  'tools/call': 'tools/list',
  'prompts/get': 'prompts/list',
}
export const BY_URI = new Set([
  'resources/read',
  'resources/subscribe',
  'resources/unsubscribe',
])

export const LIST_CHANGED =
  /^notifications\/(tools|prompts|resources)\/list_changed$/

// Whether a URI template (RFC 6570) could have produced `uri`. A simple
// expression stays inside a path segment; the operators may span several.
export const templateMatches = (template: string, uri: string) =>
  new RegExp(
    `^${template
      .split(/(\{[^}]*\})/)
      .map((part, i) =>
        i % 2 === 0
          ? part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          : /^\{[+#/.;?&]/.test(part)
            ? '.*'
            : '[^/]*',
      )
      .join('')}$`,
  ).test(uri)

export const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

// Capabilities together: what any server has, the combined server has.
export const union = (
  into: Record<string, unknown>,
  from: Record<string, unknown>,
) => {
  for (const [key, value] of Object.entries(from)) {
    const present = into[key]
    if (isObject(present) && isObject(value)) union(present, value)
    else into[key] = present || (isObject(value) ? union({}, value) : value)
  }
  return into
}
