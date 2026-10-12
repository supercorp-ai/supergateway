import type { Backend, Id } from './combinedBackend.js'

/**
 * The requests the client of a session has made and a server has yet to
 * answer: which server each went to. A request is over when that server
 * answers it or stops; an answer from any other, or a second one, is to
 * nothing.
 */
export class ClientRequests {
  private readonly doing = new Map<Id, Backend>()

  /** The request `id` went to `backend`. */
  sent(id: Id, backend: Backend) {
    this.doing.set(id, backend)
  }

  /** The server doing the request `id`, if one is. */
  by(id: Id) {
    return this.doing.get(id)
  }

  /** Whether `backend` was doing the request `id`, which is now over. */
  answered(id: Id, backend: Backend) {
    if (this.doing.get(id) !== backend) return false
    this.doing.delete(id)
    return true
  }

  /** Every request `backend` was doing, each over as it is given. */
  *abandoned(backend: Backend) {
    for (const [id, target] of this.doing) {
      if (target !== backend) continue
      this.doing.delete(id)
      yield id
    }
  }
}
