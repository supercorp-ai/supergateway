import type { Backend, Id, Request } from './combinedBackend.js'

/**
 * The requests the servers of a session have made of its client (sampling,
 * roots, elicitation) and the client has yet to answer.
 *
 * Two servers number theirs alike, so the client sees an id, and a progress
 * token, of the gateway's; the answer, and progress, go back to the server
 * under its own. A request is over when the client answers it, when its
 * server cancels it, or when its server stops: after that nothing here knows
 * of it.
 */
export class ServerRequests {
  /** By the id the client sees. */
  private readonly asked = new Map<
    string,
    { backend: Backend; id: Id; token?: string }
  >()
  /** Their progress tokens, as the client sees them. */
  private readonly tokens = new Map<string, { backend: Backend; token: Id }>()
  private count = 0

  /** A request `backend` makes, as the client is to see it. */
  add(backend: Backend, request: Request): Request {
    const n = ++this.count
    const id = `sgw:${backend.name}:${n}`
    const original = request.params?._meta?.progressToken
    const token =
      original === undefined ? undefined : `sgw:${backend.name}:${n}:progress`
    this.asked.set(id, { backend, id: request.id, token })
    backend.sent.set(request.id, id)
    if (token === undefined) return { ...request, id }
    this.tokens.set(token, { backend, token: original })
    return {
      ...request,
      id,
      params: {
        ...request.params,
        _meta: { ...request.params!._meta, progressToken: token },
      },
    }
  }

  /**
   * The request the client knows as `clientId`, now over: who made it, and
   * under which id. Nothing when there is none.
   */
  answered(clientId: string) {
    const asked = this.asked.get(clientId)
    if (!asked) return undefined
    this.forget(clientId)
    return asked
  }

  /**
   * The request `backend` made under `id`, now over: the id the client knows
   * it by. Nothing when it made none, or it is over already.
   */
  cancelled(backend: Backend, id: Id): string | undefined {
    const clientId = backend.sent.get(id)
    if (clientId === undefined) return undefined
    this.forget(clientId)
    return clientId
  }

  /**
   * Every request `backend` made, each over as it is given: the ids the
   * client knows them by.
   */
  *abandoned(backend: Backend) {
    for (const clientId of [...backend.sent.values()]) {
      this.forget(clientId)
      yield clientId
    }
  }

  /** Whose progress a token of the gateway's reports, and its own token. */
  progress(token: string) {
    return this.tokens.get(token)
  }

  private forget(clientId: string) {
    const asked = this.asked.get(clientId)!
    this.asked.delete(clientId)
    asked.backend.sent.delete(asked.id)
    if (asked.token !== undefined) this.tokens.delete(asked.token)
  }
}
