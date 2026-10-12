import type { Logger } from '../types.js'
import type { Backend } from './combinedBackend.js'
import {
  BY_URI,
  INVALID_PARAMS,
  LISTS,
  METHOD_NOT_FOUND,
  NAMED,
  RESOURCE_NOT_FOUND,
  RpcError,
  templateMatches,
  type ListMethod,
  type Params,
} from './combinedRules.js'

/**
 * Who has what in one session of combined servers: every server's lists as
 * one, and the server each tool, prompt or resource is on.
 *
 * Nothing is renamed. When two servers offer the same name, the first listed
 * in the config has it and the other's is hidden, with a warning, once for
 * the entry.
 */
export class CombinedCatalog {
  private readonly tables = new Map<ListMethod, Promise<Map<string, Backend>>>()

  constructor(
    private readonly entry: string,
    private readonly logger: Logger,
    /** The clashes already warned about, for every session of the entry. */
    private readonly warned: Set<string>,
    /** The servers still there. */
    private readonly live: () => Backend[],
  ) {}

  /** What the session knew is no longer so: the next call looks again. */
  forget() {
    this.tables.clear()
  }

  // The server a request is for: the one with the tool, prompt or resource
  // it names.
  target(method: string, params: Params | undefined) {
    if (method in NAMED) return this.named(NAMED[method], params?.name)
    if (BY_URI.has(method)) return this.byUri(params?.uri)
    if (method === 'completion/complete')
      return params?.ref?.type === 'ref/prompt'
        ? this.named('prompts/list', params.ref.name)
        : this.byUri(params?.ref?.uri)
    throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`)
  }

  // --- Lists and what they route ---

  async list(method: ListMethod, params: Params | undefined) {
    // Every list is one page, so no cursor is the gateway's.
    if (params?.cursor !== undefined)
      throw new RpcError(INVALID_PARAMS, 'Invalid cursor')
    const { items } = await this.merged(method)
    return { [LISTS[method].key]: items }
  }

  private async merged(method: ListMethod) {
    const list = LISTS[method]
    const backends = this.live().filter(
      (backend) => list.capability in backend.capabilities,
    )
    const lists = await Promise.all(
      backends.map((backend) =>
        backend.listAll(method).catch((err: Error) => {
          this.logger.error(
            `${this.entry}: ${method} of server "${backend.name}" failed: ${err.message}`,
          )
          return []
        }),
      ),
    )
    const owners = new Map<string, Backend>()
    const items = lists.flatMap((listed, i) =>
      listed.filter((item) => {
        const id = (item as Params | null)?.[list.id]
        if (typeof id !== 'string') return true
        const first = owners.get(id)
        if (!first) {
          owners.set(id, backends[i])
          return true
        }
        this.warnOfClash(list.what, id, first, backends[i])
        return false
      }),
    )
    this.tables.set(method, Promise.resolve(owners))
    return { items, owners }
  }

  private warnOfClash(
    what: string,
    id: string,
    first: Backend,
    other: Backend,
  ) {
    const key = `${what} ${id}`
    if (this.warned.has(key)) return
    this.warned.add(key)
    this.logger.error(
      `${this.entry}: ${what} "${id}" is offered by "${first.name}" and "${other.name}"; clients get the one of "${first.name}", listed first${what === 'tool' ? '. Set "toolPrefix" on one of them to keep both' : ''}`,
    )
  }

  // Who has what, from the last list; fetched if there has been none, or
  // again when `fresh`.
  private table(method: ListMethod, fresh: boolean) {
    const known = fresh ? undefined : this.tables.get(method)
    if (known) return known
    const fetched = this.merged(method).then(({ owners }) => owners)
    this.tables.set(method, fetched)
    return fetched
  }

  // The server with the tool or prompt called `name`. A name the last list
  // did not have may be new, so the list is fetched once more before it is
  // refused.
  private async named(method: ListMethod, name: unknown): Promise<Backend> {
    for (const fresh of [false, true]) {
      const owner = (await this.table(method, fresh)).get(name as string)
      if (owner && !owner.gone) return owner
    }
    throw new RpcError(INVALID_PARAMS, `Unknown ${LISTS[method].what}: ${name}`)
  }

  // The server with the resource at `uri`: one that lists it, or one with a
  // template it fits.
  private async byUri(uri: unknown): Promise<Backend> {
    for (const fresh of [false, true]) {
      const listed = (await this.table('resources/list', fresh)).get(
        uri as string,
      )
      if (listed && !listed.gone) return listed
      const templates = await this.table('resources/templates/list', fresh)
      for (const [template, owner] of templates)
        if (
          !owner.gone &&
          (template === uri || templateMatches(template, String(uri)))
        )
          return owner
    }
    throw new RpcError(RESOURCE_NOT_FOUND, 'Resource not found', { uri })
  }
}
