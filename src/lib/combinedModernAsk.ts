import type { ModernChild } from './upstreamModernChild.js'
import type { Request, Answer, ModernMember } from './combinedModernTypes.js'
import type { JSONRPCMessage } from './modernSdk.js'
import type { Params, ListMethod } from './combinedRules.js'

// One request of the gateway's own to a server started for it, and its
// answer. Whatever else the server says meanwhile is not the client's.
export function ask(child: ModernChild, request: Request): Promise<Answer> {
  return new Promise((resolve, reject) => {
    child.onmessage = (message) => {
      if (
        'id' in message &&
        !('method' in message) &&
        message.id === request.id
      )
        resolve(message as Answer)
    }
    child.onerror = reject
    child.onclose = () => reject(new Error('The server stopped'))
    child.send(request as JSONRPCMessage).catch(reject)
  })
}

// Nothing a server says or does any more is anyone's.
export const detach = (child: ModernChild) => {
  child.onmessage = undefined
  child.onerror = undefined
  child.onclose = undefined
}

// A server's own name for what the client calls `id`: a tool's, without the
// server's prefix.
export const ownName = (
  member: ModernMember,
  method: ListMethod,
  id: string,
) =>
  method === 'tools/list' && member.toolNames
    ? id.slice(member.toolNames.prefix.length)
    : id

// Every page of one server's list. One that has no such list has none.
export async function allPages(server: {
  ask: (cursor?: string) => Promise<Answer>
}): Promise<Params[]> {
  const pages: Params[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  do {
    const answer = await server.ask(cursor)
    if (!answer.result) return pages
    pages.push(answer.result)
    // A server that repeats a cursor would be asked forever.
    if (cursor !== undefined) seen.add(cursor)
    cursor = seen.has(answer.result.nextCursor)
      ? undefined
      : answer.result.nextCursor
  } while (typeof cursor === 'string')
  return pages
}

// How long a client may keep an answer made of several: no longer than the
// shortest any of them allows, and privately if any is private.
export function cacheHints(results: Params[]) {
  const ttls = results
    .map((result) => result.ttlMs)
    .filter((ttl) => typeof ttl === 'number')
  return {
    ...(ttls.length ? { ttlMs: Math.min(...ttls) } : {}),
    ...(results.some((result) => result.cacheScope === 'private')
      ? { cacheScope: 'private' }
      : {}),
  }
}
