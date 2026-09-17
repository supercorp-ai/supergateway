import { randomUUID } from 'node:crypto'
import type { Logger } from '../types.js'
import type { OwnedStdioTransport } from './ownedStdioTransport.js'

export const CONTINUATION_TIMEOUT = 300_000
/** Bound saved states as well as the processes they keep alive. */
export const RETAINED_CHILD_LIMIT = 64
export const isContinuationHandle = (state: unknown): state is string =>
  typeof state === 'string' && state.startsWith('sgw:')

type Flow = {
  child: OwnedStdioTransport
  handles: Set<string>
  waiters: Set<() => void>
  busy: boolean
  timer?: NodeJS.Timeout
}
type Binding = { flow: Flow; state: string | undefined }

/** Request state stays opaque; gateway handles identify its owning process. */
export class RetainedChildren {
  private readonly entries = new Map<string, Binding>()
  private readonly flows = new WeakMap<OwnedStdioTransport, Flow>()
  private readonly closing = new Set<Promise<void>>()
  private closed = false

  constructor(
    private readonly options: { idleMs: number; limit: number; logger: Logger },
  ) {}

  get size(): number {
    return this.entries.size
  }

  retain(state: string | undefined, child: OwnedStdioTransport): string {
    let flow = this.flows.get(child)
    if (!flow) {
      flow = { child, handles: new Set(), waiters: new Set(), busy: true }
      this.flows.set(child, flow)
    }
    const handle = `sgw:${randomUUID()}`
    flow.handles.add(handle)
    this.entries.set(handle, { flow, state })
    while (this.entries.size > this.options.limit) {
      const oldest = this.entries.keys().next().value!
      const previous = this.entries.get(oldest)!
      this.entries.delete(oldest)
      previous.flow.handles.delete(oldest)
      this.wake(previous.flow)
      if (!previous.flow.busy && previous.flow.handles.size === 0)
        void this.discard(previous.flow.child)
    }
    return handle
  }

  async take(
    handle: string,
    signal?: AbortSignal,
  ): Promise<
    { child: OwnedStdioTransport; state: string | undefined } | undefined
  > {
    for (;;) {
      const binding = this.entries.get(handle)
      if (!binding || this.closed || signal?.aborted) return undefined
      const flow = binding.flow
      if (!flow.busy) {
        flow.busy = true
        clearTimeout(flow.timer)
        flow.child.onmessage = undefined
        flow.child.onerror = undefined
        flow.child.onclose = undefined
        // Recently used states survive capacity eviction before older ones.
        this.entries.delete(handle)
        this.entries.set(handle, binding)
        return { child: flow.child, state: binding.state }
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          flow.waiters.delete(done)
          signal?.removeEventListener('abort', done)
          resolve()
        }
        flow.waiters.add(done)
        signal?.addEventListener('abort', done, { once: true })
      })
    }
  }

  async release(child: OwnedStdioTransport): Promise<void> {
    const flow = this.flows.get(child)
    if (this.closed || !flow || flow.handles.size === 0) {
      await this.discard(child)
      return
    }
    flow.busy = false
    clearTimeout(flow.timer)
    child.onmessage = () => {}
    child.onerror = () => {
      void this.discard(child)
    }
    child.onclose = () => {
      void this.discard(child)
    }
    flow.timer = setTimeout(() => void this.discard(child), this.options.idleMs)
    this.wake(flow)
  }

  async discard(child: OwnedStdioTransport): Promise<void> {
    const flow = this.flows.get(child)
    if (flow) {
      clearTimeout(flow.timer)
      for (const handle of flow.handles) this.entries.delete(handle)
      flow.handles.clear()
      this.flows.delete(child)
      this.wake(flow)
    }
    child.onmessage = undefined
    child.onerror = undefined
    child.onclose = undefined
    const closing = child.close().catch((error) => {
      this.options.logger.error('Failed to close retained MCP child:', error)
    })
    this.closing.add(closing)
    try {
      await closing
    } finally {
      this.closing.delete(closing)
    }
  }

  async close(): Promise<void> {
    this.closed = true
    const children = new Set(
      [...this.entries.values()].map((binding) => binding.flow.child),
    )
    await Promise.all([...children].map((child) => this.discard(child)))
    await Promise.all(this.closing)
  }

  private wake(flow: Flow): void {
    for (const done of flow.waiters) done()
  }
}
