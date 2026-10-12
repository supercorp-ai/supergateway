import type { Params, ListMethod } from './combinedRules.js'
import type { ToolNames } from './toolNames.js'
import type { ModernChild } from './upstreamModernChild.js'

type Id = string | number
export type Request = {
  jsonrpc: '2.0'
  id: Id
  method: string
  params?: Params
}
export type Answer = { jsonrpc: '2.0'; id: Id; result?: Params; error?: Params }

/** What the client's request declared, for a server that is sent it. */
export interface ModernRequestInfo {
  version: string | undefined
  params: Record<string, string>
}

/** One of the servers combined, as a 2026-07-28 request reaches it. */
export interface ModernMember {
  name: string
  toolNames?: ToolNames
  /** Nothing for a server that has no such requests (a remote SSE one). */
  child?: (request: ModernRequestInfo) => ModernChild
}

/** A combined entry, and what its requests share: who has what. */
export interface CombinedModernEntry {
  name: string
  members: ModernMember[]
  /** By list, what a client names, and the server and its own name for it. */
  tables: Map<ListMethod, Map<string, { member: ModernMember; own: string }>>
  /** The clashes already warned about, with the entry's sessions. */
  warned: Set<string>
}
