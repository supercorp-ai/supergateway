import type {
  CombinedModernEntry,
  ModernMember,
  Request,
} from './combinedModernTypes.js'
import type { Logger } from '../types.js'
import { allPages, cacheHints, ownName, type ask } from './combinedModernAsk.js'
import {
  BY_URI,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  LISTS,
  METHOD_NOT_FOUND,
  NAMED,
  RESOURCE_NOT_FOUND,
  RpcError,
  isObject,
  templateMatches,
  union,
  type ListMethod,
  type Params,
} from './combinedRules.js'
import { getVersion } from './getVersion.js'

/** Every server of the entry, started for this request, and how to ask it. */
type AskEach = (
  method: string,
  params: Params | undefined,
) => Promise<
  { member: ModernMember; ask: (cursor?: string) => ReturnType<typeof ask> }[]
>

/**
 * What one 2026-07-28 request of combined servers needs to know of them all:
 * what they are as one server (`server/discover`), their lists as one page,
 * and which server a name or a resource is on.
 */
export class CombinedModernCatalog {
  constructor(
    private readonly entry: CombinedModernEntry,
    private readonly logger: Logger,
    private readonly askEach: AskEach,
  ) {}

  async discover(request: Request): Promise<Params> {
    const servers = await this.askEach(request.method, request.params)
    const answers = await Promise.all(servers.map(({ ask }) => ask()))
    const results = answers.map((answer, i) => {
      if (!answer.result)
        throw new RpcError(
          INTERNAL_ERROR,
          `Server "${servers[i].member.name}" failed: ${answer.error?.message}`,
        )
      return answer.result
    })
    const instructions = results
      .map((result, i) =>
        typeof result.instructions === 'string'
          ? `## ${servers[i].member.name}\n\n${result.instructions}`
          : '',
      )
      .filter(Boolean)
      .join('\n\n')
    const { instructions: _own, ...first } = results[0]
    return {
      ...first,
      supportedVersions: results
        .map((result) => result.supportedVersions as string[])
        .reduce((all, versions) => all.filter((v) => versions.includes(v))),
      capabilities: results.reduce(
        (all, result) =>
          union(all, isObject(result.capabilities) ? result.capabilities : {}),
        {},
      ),
      serverInfo: {
        name: 'supergateway',
        title: this.entry.name,
        version: getVersion(),
      },
      ...(instructions ? { instructions } : {}),
      ...cacheHints(results),
    }
  }

  async list(method: ListMethod, params: Params | undefined) {
    // Every list is one page, so no cursor is the gateway's.
    if (params?.cursor !== undefined)
      throw new RpcError(INVALID_PARAMS, 'Invalid cursor')
    const list = LISTS[method]
    // The call's progress token names the client's request, not these.
    const { progressToken: _token, ..._meta } = params?._meta ?? {}
    const servers = await this.askEach(method, { ...params, _meta })
    const pages = await Promise.all(
      servers.map((server) =>
        // A server whose list fails is left out of it; the others' stand.
        allPages(server).catch((err: Error) => {
          this.logger.error(
            `${this.entry.name}: ${method} of server "${server.member.name}" failed: ${err.message}`,
          )
          return []
        }),
      ),
    )
    const owners = new Map<string, { member: ModernMember; own: string }>()
    const items = pages.flatMap((results, i) => {
      const { member } = servers[i]
      const own = results.flatMap((result) =>
        Array.isArray(result[list.key]) ? (result[list.key] as unknown[]) : [],
      )
      // A server's own tool settings, as its sessions see them.
      const shown =
        method === 'tools/list' && member.toolNames
          ? (member.toolNames.listed({ tools: own }).tools as unknown[])
          : own
      return shown.filter((item) => {
        const id = (item as Params | null)?.[list.id]
        if (typeof id !== 'string') return true
        const first = owners.get(id)
        if (!first) {
          owners.set(id, { member, own: ownName(member, method, id) })
          return true
        }
        this.warnOfClash(list.what, id, first.member, member)
        return false
      })
    })
    this.entry.tables.set(method, owners)
    const all = pages.flat()
    const { nextCursor: _cursor, [list.key]: _items, ...first } = all[0] ?? {}
    return { ...first, [list.key]: items, ...cacheHints(all) }
  }

  private warnOfClash(
    what: string,
    id: string,
    first: ModernMember,
    other: ModernMember,
  ) {
    const key = `${what} ${id}`
    if (this.entry.warned.has(key)) return
    this.entry.warned.add(key)
    this.logger.error(
      `${this.entry.name}: ${what} "${id}" is offered by "${first.name}" and "${other.name}"; clients get the one of "${first.name}", listed first${what === 'tool' ? '. Set "toolPrefix" on one of them to keep both' : ''}`,
    )
  }

  // Who has what a request names: from the entry's table, or from a list
  // fetched when the table does not have it; the name may be new.
  private async owner(method: ListMethod, id: unknown, meta: unknown) {
    const known = this.entry.tables.get(method)?.get(id as string)
    if (known) return known
    await this.list(method, { _meta: meta })
    return this.entry.tables.get(method)!.get(id as string)
  }

  // The server with a template `uri` fits, by the same two looks.
  private async templateOwner(uri: unknown, meta: unknown) {
    const fits = () =>
      [...(this.entry.tables.get('resources/templates/list') ?? [])].find(
        ([template]) =>
          template === uri || templateMatches(template, String(uri)),
      )?.[1]
    const known = fits()
    if (known) return known
    await this.list('resources/templates/list', { _meta: meta })
    return fits()
  }

  // The server a request is for: the one with the tool, prompt or resource
  // it names.
  async target(method: string, params: Params | undefined) {
    const meta = params?._meta
    const completes = method === 'completion/complete'
    const named: [ListMethod, unknown] | undefined =
      completes && params?.ref?.type === 'ref/prompt'
        ? ['prompts/list', params.ref.name]
        : method in NAMED
          ? [NAMED[method], params?.name]
          : undefined
    if (named) {
      const owner = await this.owner(named[0], named[1], meta)
      if (owner) return owner
      throw new RpcError(
        INVALID_PARAMS,
        `Unknown ${LISTS[named[0]].what}: ${named[1]}`,
      )
    }
    if (!completes && !BY_URI.has(method))
      throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`)
    const uri = completes ? params?.ref?.uri : params?.uri
    const owner =
      (await this.owner('resources/list', uri, meta)) ??
      (await this.templateOwner(uri, meta))
    if (owner) return owner
    throw new RpcError(RESOURCE_NOT_FOUND, 'Resource not found', { uri })
  }
}
